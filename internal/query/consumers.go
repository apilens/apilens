package query

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Consumers: the API consumers (the consumer_id the SDK reports) of a
// project, with their traffic in a range, a per-consumer sparkline, unique
// consumers over time split into new and returning, and one consumer's
// detail (metrics, timeseries, recent requests and errors).
//
// A consumer is new in a range (or in one bucket of it) when its first_seen
// falls inside that range (bucket), returning otherwise. first_seen and
// last_seen come from api_consumers, a ClickHouse materialized view keyed by
// (project_id, consumer_id) over every request ever stored, so they are
// project-wide whatever the environment filter. Traffic numbers read raw
// api_requests (consumer is not a rollup dimension), pruned by the sort key
// on project and time.

// maxRecent is how many recent requests and errors the detail lists.
const maxRecent = 50

// consumerSeen merges a project's api_consumers rows per consumer.
const consumerSeen = `SELECT consumer_id, min(first_seen) AS first_seen, max(last_seen) AS last_seen, argMaxMerge(consumer_name) AS name
	FROM api_consumers WHERE project_id = ?`

type consumersInput struct {
	RangeInput
	Group string `query:"group" format:"uuid" doc:"Only the consumers in this consumer group (an id from list-consumer-groups); empty means all."`
	Limit int    `query:"limit" minimum:"1" maximum:"500" default:"100" doc:"Most consumers to list, by requests."`
}

// ConsumerGroupRef names the group a consumer is in.
type ConsumerGroupRef struct {
	ID   string `json:"id" format:"uuid"`
	Name string `json:"name"`
}

type consumerRow struct {
	ConsumerID   string            `json:"consumer_id"`
	ConsumerName string            `json:"consumer_name" doc:"Most recently reported name of the consumer in the range."`
	Group        *ConsumerGroupRef `json:"group,omitempty" doc:"The consumer group the consumer is assigned to; absent when none."`
	FirstSeen    time.Time         `json:"first_seen" doc:"First request ever seen from the consumer in the project."`
	LastSeen     time.Time         `json:"last_seen" doc:"Last request ever seen from the consumer in the project."`
	New          bool              `json:"new" doc:"Whether first_seen falls within the range."`
	StatusSplit
	Sparkline []uint64 `json:"sparkline" doc:"Requests per bucket of the range (bucket_seconds wide), oldest first, zero-filled."`
}

// ConsumerCounts counts unique consumers, split by whether they were first
// seen in the period. Exported so Huma reads the fields of the types
// embedding it.
type ConsumerCounts struct {
	Consumers uint64 `json:"consumers" doc:"Unique consumers with requests in the period."`
	New       uint64 `json:"new" doc:"Consumers whose first request ever falls in the period."`
	Returning uint64 `json:"returning" doc:"Consumers first seen before the period."`
}

type consumersPoint struct {
	TS time.Time `json:"ts" doc:"Start of the bucket."`
	ConsumerCounts
}

type consumersOutput struct {
	Body struct {
		Range         string           `json:"range"`
		From          time.Time        `json:"from"`
		To            time.Time        `json:"to"`
		BucketSeconds int              `json:"bucket_seconds"`
		Summary       ConsumerCounts   `json:"summary" doc:"Unique consumers of the whole range; new means first seen within the range."`
		Points        []consumersPoint `json:"points" doc:"Unique consumers per bucket, zero-filled; new means first seen within that bucket."`
		Consumers     []consumerRow    `json:"consumers" doc:"Consumers by requests, most first."`
	}
}

type consumerInput struct {
	RangeInput
	ConsumerID string `path:"consumer_id" minLength:"1" maxLength:"256" doc:"The consumer id the SDK reports, URL-encoded as one path segment."`
}

type consumerSummary struct {
	StatusSplit
	RequestsPerMinute float64 `json:"requests_per_minute"`
}

type consumerOutput struct {
	Body struct {
		ConsumerID     string                  `json:"consumer_id"`
		ConsumerName   string                  `json:"consumer_name" doc:"Most recently reported name of the consumer."`
		Group          *ConsumerGroupRef       `json:"group,omitempty" doc:"The consumer group the consumer is assigned to; absent when none."`
		FirstSeen      time.Time               `json:"first_seen"`
		LastSeen       time.Time               `json:"last_seen"`
		New            bool                    `json:"new" doc:"Whether first_seen falls within the range."`
		Range          string                  `json:"range"`
		From           time.Time               `json:"from"`
		To             time.Time               `json:"to"`
		BucketSeconds  int                     `json:"bucket_seconds"`
		Summary        consumerSummary         `json:"summary"`
		Points         []endpointRequestsPoint `json:"points" doc:"One point per bucket of the range, zero-filled."`
		RecentRequests []requestRow            `json:"recent_requests" doc:"The consumer's latest requests in the range (at most 50), newest first."`
		RecentErrors   []requestRow            `json:"recent_errors" doc:"The consumer's latest 4xx and 5xx requests in the range (at most 50), newest first."`
	}
}

// ConsumerGroupLookup is the control-plane subset the consumer list and
// detail use to name each consumer's group; *db.Queries satisfies it. When
// the Service's Catalog does not implement it, groups are reported as null
// and the group filter answers 503.
type ConsumerGroupLookup interface {
	ListConsumerGroupAssignments(ctx context.Context, arg db.ListConsumerGroupAssignmentsParams) ([]db.ListConsumerGroupAssignmentsRow, error)
	ListConsumerGroupMembers(ctx context.Context, arg db.ListConsumerGroupMembersParams) ([]string, error)
}

// consumerGroups names the groups of ids; nil when groups are unavailable.
func (s *Service) consumerGroups(ctx context.Context, project uuid.UUID, ids []string) (map[string]*ConsumerGroupRef, error) {
	store, ok := s.catalog.(ConsumerGroupLookup)
	if !ok || len(ids) == 0 {
		return nil, nil
	}
	rows, err := store.ListConsumerGroupAssignments(ctx, db.ListConsumerGroupAssignmentsParams{ProjectID: project, ConsumerIds: ids})
	if err != nil {
		return nil, internalError("consumer groups", err)
	}
	out := make(map[string]*ConsumerGroupRef, len(rows))
	for _, r := range rows {
		out[r.ConsumerID] = &ConsumerGroupRef{ID: r.GroupID.String(), Name: r.GroupName}
	}
	return out, nil
}

func (s *Service) consumers(ctx context.Context, in *consumersInput) (*consumersOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	seconds := int(w.bucket.Seconds())
	out := &consumersOutput{}
	b := &out.Body
	b.Range, b.From, b.To, b.BucketSeconds = w.name, w.from, w.to, seconds
	b.Consumers = []consumerRow{}
	b.Points = make([]consumersPoint, 0, int(w.to.Sub(w.from)/w.bucket))

	where, args := tenantFilter(p.ProjectID, in.Env)
	where += " AND timestamp >= ? AND timestamp < ? AND consumer_id != ''"
	args = append(args, w.from, w.to)
	if in.Group != "" {
		members, err := s.groupMembers(ctx, p.ProjectID, in.Group)
		if err != nil {
			return nil, err
		}
		if len(members) == 0 {
			for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
				b.Points = append(b.Points, consumersPoint{TS: t})
			}
			return out, nil
		}
		where += " AND has(?, consumer_id)"
		args = append(args, members)
	}

	qctx, cancel := queryCtx(ctx)
	defer cancel()

	// Consumers of the range by requests.
	rows, err := s.ch.Query(qctx, `
		SELECT consumer_id, argMax(consumer_name, timestamp), `+rawSplit+`
		FROM api_requests WHERE `+where+`
		GROUP BY consumer_id ORDER BY n DESC, consumer_id LIMIT ?`, append(args, in.Limit)...)
	if err != nil {
		return nil, internalError("consumers", err)
	}
	ids := []string{}
	for rows.Next() {
		var c consumerRow
		if err := rows.Scan(&c.ConsumerID, &c.ConsumerName, &c.Requests, &c.Successful, &c.ClientErrors, &c.ServerErrors); err != nil {
			_ = rows.Close()
			return nil, internalError("consumers", err)
		}
		b.Consumers = append(b.Consumers, c)
		ids = append(ids, c.ConsumerID)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("consumers", err)
	}

	if len(ids) > 0 {
		if err := s.fillConsumers(qctx, p.ProjectID, w, where, args, ids, b.Consumers); err != nil {
			return nil, err
		}
		groups, err := s.consumerGroups(ctx, p.ProjectID, ids)
		if err != nil {
			return nil, err
		}
		for i := range b.Consumers {
			b.Consumers[i].Group = groups[b.Consumers[i].ConsumerID]
		}
	}

	// Unique consumers per bucket, new when first seen within the bucket.
	// The bucket width comes from the fixed ranges map, never from input.
	firstSeen := `(SELECT consumer_id, min(first_seen) AS first_seen FROM api_consumers WHERE project_id = ? GROUP BY consumer_id)`
	prows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT r.t, count(), countIf(f.first_seen >= r.t AND f.first_seen < r.t + INTERVAL %[1]d SECOND)
		FROM (SELECT DISTINCT toDateTime(toStartOfInterval(timestamp, INTERVAL %[1]d SECOND), 'UTC') AS t, consumer_id
		      FROM api_requests WHERE %[2]s) AS r
		LEFT JOIN %[3]s AS f ON r.consumer_id = f.consumer_id
		GROUP BY r.t ORDER BY r.t`, seconds, where, firstSeen), append(append([]any{}, args...), p.ProjectID)...)
	if err != nil {
		return nil, internalError("consumers timeseries", err)
	}
	got := map[int64]ConsumerCounts{}
	for prows.Next() {
		var (
			t time.Time
			c ConsumerCounts
		)
		if err := prows.Scan(&t, &c.Consumers, &c.New); err != nil {
			_ = prows.Close()
			return nil, internalError("consumers timeseries", err)
		}
		c.Returning = c.Consumers - c.New
		got[t.UTC().Unix()] = c
	}
	_ = prows.Close()
	if err := prows.Err(); err != nil {
		return nil, internalError("consumers timeseries", err)
	}
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		b.Points = append(b.Points, consumersPoint{TS: t, ConsumerCounts: got[t.Unix()]})
	}

	// Unique consumers of the whole range, new when first seen within it.
	err = s.ch.QueryRow(qctx, `
		SELECT count(), countIf(f.first_seen >= ?)
		FROM (SELECT DISTINCT consumer_id FROM api_requests WHERE `+where+`) AS r
		LEFT JOIN `+firstSeen+` AS f ON r.consumer_id = f.consumer_id`,
		append(append([]any{w.from}, args...), p.ProjectID)...).Scan(&b.Summary.Consumers, &b.Summary.New)
	if err != nil {
		return nil, internalError("consumers summary", err)
	}
	b.Summary.Returning = b.Summary.Consumers - b.Summary.New
	return out, nil
}

// fillConsumers sets first/last seen, new and the sparkline of the listed
// consumers (cs, whose ids are ids). where and args select the range's rows.
func (s *Service) fillConsumers(ctx context.Context, project uuid.UUID, w window, where string, args []any, ids []string, cs []consumerRow) error {
	type seen struct{ first, last time.Time }
	seenBy := map[string]seen{}
	rows, err := s.ch.Query(ctx, `SELECT consumer_id, min(first_seen), max(last_seen)
		FROM api_consumers WHERE project_id = ? AND has(?, consumer_id) GROUP BY consumer_id`, project, ids)
	if err != nil {
		return internalError("consumers seen", err)
	}
	for rows.Next() {
		var (
			id string
			v  seen
		)
		if err := rows.Scan(&id, &v.first, &v.last); err != nil {
			_ = rows.Close()
			return internalError("consumers seen", err)
		}
		seenBy[id] = v
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return internalError("consumers seen", err)
	}

	n := int(w.to.Sub(w.from) / w.bucket)
	spark := make(map[string][]uint64, len(ids))
	for _, id := range ids {
		spark[id] = make([]uint64, n)
	}
	seconds := int(w.bucket.Seconds())
	// The bucket width comes from the fixed ranges map, never from input.
	srows, err := s.ch.Query(ctx, fmt.Sprintf(`
		SELECT consumer_id, toDateTime(toStartOfInterval(timestamp, INTERVAL %d SECOND), 'UTC') AS t, count()
		FROM api_requests WHERE %s AND has(?, consumer_id)
		GROUP BY consumer_id, t`, seconds, where), append(append([]any{}, args...), ids)...)
	if err != nil {
		return internalError("consumers sparkline", err)
	}
	for srows.Next() {
		var (
			id string
			t  time.Time
			c  uint64
		)
		if err := srows.Scan(&id, &t, &c); err != nil {
			_ = srows.Close()
			return internalError("consumers sparkline", err)
		}
		if i := int(t.Sub(w.from) / w.bucket); i >= 0 && i < n && spark[id] != nil {
			spark[id][i] = c
		}
	}
	_ = srows.Close()
	if err := srows.Err(); err != nil {
		return internalError("consumers sparkline", err)
	}

	for i := range cs {
		c := &cs[i]
		if v, ok := seenBy[c.ConsumerID]; ok {
			c.FirstSeen, c.LastSeen = v.first.UTC(), v.last.UTC()
		}
		c.New = !c.FirstSeen.Before(w.from)
		c.Sparkline = spark[c.ConsumerID]
	}
	return nil
}

// groupMembers lists the consumers of group, which must be a group of project.
func (s *Service) groupMembers(ctx context.Context, project uuid.UUID, group string) ([]string, error) {
	store, ok := s.catalog.(ConsumerGroupLookup)
	if !ok {
		return nil, huma.Error503ServiceUnavailable("consumer groups unavailable")
	}
	id, err := uuid.Parse(group)
	if err != nil {
		return nil, huma.Error422UnprocessableEntity("group must be a consumer group id")
	}
	ids, err := store.ListConsumerGroupMembers(ctx, db.ListConsumerGroupMembersParams{ProjectID: project, GroupID: id})
	if err != nil {
		return nil, internalError("consumer group members", err)
	}
	return ids, nil
}

func (s *Service) consumer(ctx context.Context, in *consumerInput) (*consumerOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	seconds := int(w.bucket.Seconds())
	out := &consumerOutput{}
	b := &out.Body
	b.ConsumerID, b.Range, b.From, b.To, b.BucketSeconds = in.ConsumerID, w.name, w.from, w.to, seconds

	qctx, cancel := queryCtx(ctx)
	defer cancel()
	var id string
	err = s.ch.QueryRow(qctx, consumerSeen+` AND consumer_id = ? GROUP BY consumer_id`, p.ProjectID, in.ConsumerID).
		Scan(&id, &b.FirstSeen, &b.LastSeen, &b.ConsumerName)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, huma.Error404NotFound("consumer not found")
	}
	if err != nil {
		return nil, internalError("consumer", err)
	}
	b.FirstSeen, b.LastSeen = b.FirstSeen.UTC(), b.LastSeen.UTC()
	b.New = !b.FirstSeen.Before(w.from)
	groups, err := s.consumerGroups(ctx, p.ProjectID, []string{in.ConsumerID})
	if err != nil {
		return nil, err
	}
	b.Group = groups[in.ConsumerID]

	where, args := tenantFilter(p.ProjectID, in.Env)
	where += " AND timestamp >= ? AND timestamp < ? AND consumer_id = ?"
	args = append(args, w.from, w.to, in.ConsumerID)

	// The bucket width comes from the fixed ranges map, never from input.
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toDateTime(toStartOfInterval(timestamp, INTERVAL %d SECOND), 'UTC') AS t, %s
		FROM api_requests WHERE %s GROUP BY t ORDER BY t`, seconds, rawSplit, where), args...)
	if err != nil {
		return nil, internalError("consumer timeseries", err)
	}
	got := map[int64]StatusSplit{}
	for rows.Next() {
		var (
			t  time.Time
			sp StatusSplit
		)
		if err := rows.Scan(&t, &sp.Requests, &sp.Successful, &sp.ClientErrors, &sp.ServerErrors); err != nil {
			_ = rows.Close()
			return nil, internalError("consumer timeseries", err)
		}
		got[t.UTC().Unix()] = sp
		b.Summary.Requests += sp.Requests
		b.Summary.Successful += sp.Successful
		b.Summary.ClientErrors += sp.ClientErrors
		b.Summary.ServerErrors += sp.ServerErrors
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("consumer timeseries", err)
	}
	b.Summary.RequestsPerMinute = float64(b.Summary.Requests) / w.to.Sub(w.from).Minutes()
	b.Points = make([]endpointRequestsPoint, 0, int(w.to.Sub(w.from)/w.bucket))
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		b.Points = append(b.Points, endpointRequestsPoint{TS: t, StatusSplit: got[t.Unix()]})
	}

	if b.RecentRequests, err = s.recentRequests(qctx, where, args); err != nil {
		return nil, err
	}
	if b.RecentErrors, err = s.recentRequests(qctx, where+" AND status_code >= 400", args); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Service) recentRequests(ctx context.Context, where string, args []any) ([]requestRow, error) {
	rows, err := s.ch.Query(ctx, `
		SELECT timestamp, method, path, raw_path, status_code, response_time_ms, environment, consumer_id, consumer_name, trace_id
		FROM api_requests WHERE `+where+`
		ORDER BY timestamp DESC LIMIT ?`, append(append([]any{}, args...), maxRecent)...)
	if err != nil {
		return nil, internalError("consumer requests", err)
	}
	defer func() { _ = rows.Close() }()
	out := []requestRow{}
	for rows.Next() {
		var r requestRow
		if err := rows.Scan(&r.Timestamp, &r.Method, &r.Path, &r.RawPath, &r.StatusCode, &r.ResponseTimeMs,
			&r.Environment, &r.ConsumerID, &r.ConsumerName, &r.TraceID); err != nil {
			return nil, internalError("consumer requests", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("consumer requests", err)
	}
	return out, nil
}
