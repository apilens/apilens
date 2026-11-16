package query

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// Consumers: the users of a project's API (the consumer_id the SDK reports,
// usually the customer's own user id), with their traffic in a range, a
// per-consumer sparkline, unique consumers over time split into new and
// returning, and one consumer's detail (metrics, timeseries, top endpoints,
// recent requests and errors).
//
// A consumer's group is what the SDK reports with each request
// (consumer_group, e.g. the company or plan the user belongs to): the list
// and detail show the most recent non-empty one seen in the range, and the
// group filter keeps the requests tagged with that group. Groups are never
// assigned in the dashboard.
//
// A consumer is new in a range (or in one bucket of it) when its first_seen
// falls inside that range (bucket), returning otherwise. first_seen and
// last_seen come from api_consumers, a ClickHouse materialized view keyed by
// (project_id, consumer_id) over every request ever stored, so they are
// project-wide whatever the environment filter. Traffic numbers read raw
// api_requests (consumer is not a rollup dimension), pruned by the sort key
// on project and time.

// maxRecent is the default page of recent requests and errors the detail lists.
const maxRecent = 50

// maxTopEndpoints is how many endpoints the consumer detail lists.
const maxTopEndpoints = 10

// consumerSeen merges a project's api_consumers rows per consumer.
const consumerSeen = `SELECT consumer_id, min(first_seen) AS first_seen, max(last_seen) AS last_seen, argMaxMerge(consumer_name) AS name
	FROM api_consumers WHERE project_id = ?`

// latestGroup is the most recent non-empty consumer group of the rows.
const latestGroup = `argMaxIf(consumer_group, timestamp, consumer_group != '')`

type consumersInput struct {
	RangeInput
	Group  string `query:"group" maxLength:"256" example:"Acme Corp" doc:"Only requests the SDK tagged with this consumer group (the consumer_group it reports); empty means all."`
	Search string `query:"search" maxLength:"256" doc:"Only consumers whose id or name contains this text, ignoring case. Narrows consumers and total, not summary, totals or points."`
	Sort   string `query:"sort" enum:"requests,errors,last_seen" default:"requests" doc:"Order of consumers, largest or latest first: requests, errors (4xx and 5xx) or last_seen (last request in the range)."`
	Limit  int    `query:"limit" minimum:"1" maximum:"500" default:"100" doc:"Most consumers to list."`
	Offset int    `query:"offset" minimum:"0" maximum:"100000" default:"0" doc:"Consumers to skip, for paging. Past the end answers an empty page with the real total."`
}

type consumerRow struct {
	ConsumerID    string    `json:"consumer_id" doc:"Consumer id the SDK reported."`
	ConsumerName  string    `json:"consumer_name" doc:"Most recently reported name of the consumer in the range."`
	ConsumerGroup string    `json:"consumer_group" doc:"Most recent non-empty consumer group the SDK reported for the consumer in the range; empty when none."`
	FirstSeen     time.Time `json:"first_seen" doc:"First request ever seen from the consumer in the project."`
	LastSeen      time.Time `json:"last_seen" doc:"Last request ever seen from the consumer in the project."`
	New           bool      `json:"new" doc:"Whether first_seen falls within the range."`
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
		Range         string           `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From          time.Time        `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To            time.Time        `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		BucketSeconds int              `json:"bucket_seconds" doc:"Width of each series bucket, in seconds."`
		Summary       ConsumerCounts   `json:"summary" doc:"Unique consumers of the whole range; new means first seen within the range."`
		Totals        StatusSplit      `json:"totals" doc:"Requests of identified consumers in the range by outcome (group applied, search not)."`
		Points        []consumersPoint `json:"points" doc:"Unique consumers per bucket, zero-filled; new means first seen within that bucket."`
		Total         uint64           `json:"total" doc:"Consumers matching group and search in the range, across all pages."`
		Consumers     []consumerRow    `json:"consumers" doc:"One page of consumers (limit, offset), in sort order."`
	}
}

type consumerInput struct {
	RangeInput
	ConsumerID string `path:"consumer_id" minLength:"1" maxLength:"256" example:"usr_1f3a9c" doc:"The consumer id the SDK reports, URL-encoded as one path segment."`
	Limit      int    `query:"limit" minimum:"1" maximum:"100" default:"50" doc:"Most recent requests, and most recent errors, to list."`
	Offset     int    `query:"offset" minimum:"0" maximum:"10000" default:"0" doc:"Recent requests and errors to skip, for paging. Their totals are summary.requests and summary.client_errors plus summary.server_errors."`
}

type consumerSummary struct {
	StatusSplit
	RequestsPerMinute float64 `json:"requests_per_minute" doc:"requests / minutes of the range."`
}

// consumerEndpoint is one of the endpoints a consumer called most in the range.
type consumerEndpoint struct {
	Method string `json:"method" doc:"HTTP method."`
	Path   string `json:"path" doc:"Route template the requests matched, e.g. /orders/{id}."`
	StatusSplit
}

type consumerOutput struct {
	Body struct {
		ConsumerID     string                  `json:"consumer_id" doc:"Consumer id the SDK reported."`
		ConsumerName   string                  `json:"consumer_name" doc:"Most recently reported name of the consumer."`
		ConsumerGroup  string                  `json:"consumer_group" doc:"Most recent non-empty consumer group the SDK reported for the consumer in the range; empty when none."`
		FirstSeen      time.Time               `json:"first_seen" doc:"First request ever seen from the consumer in the project."`
		LastSeen       time.Time               `json:"last_seen" doc:"Last request ever seen from the consumer in the project."`
		New            bool                    `json:"new" doc:"Whether first_seen falls within the range."`
		Range          string                  `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From           time.Time               `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To             time.Time               `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		BucketSeconds  int                     `json:"bucket_seconds" doc:"Width of each series bucket, in seconds."`
		Summary        consumerSummary         `json:"summary" doc:"The consumer's requests of the range by outcome."`
		Points         []endpointRequestsPoint `json:"points" doc:"One point per bucket of the range, zero-filled."`
		TopEndpoints   []consumerEndpoint      `json:"top_endpoints" doc:"The endpoints the consumer called most in the range (at most 10), most requests first."`
		RecentRequests []requestRow            `json:"recent_requests" doc:"One page (limit, offset) of the consumer's requests in the range, newest first."`
		RecentErrors   []requestRow            `json:"recent_errors" doc:"One page (limit, offset) of the consumer's 4xx and 5xx requests in the range, newest first."`
	}
}

// consumerSorts maps the sort parameter to an ORDER BY over the aliases of
// the consumers query. Queries take the clause from here, never from input.
var consumerSorts = map[string]string{
	"":          "n DESC",
	"requests":  "n DESC",
	"errors":    "errs DESC, n DESC",
	"last_seen": "last_ts DESC",
}

// consumerSearch keeps the consumers whose id or latest name (alias name)
// contains the search text, ignoring case.
const consumerSearch = ` HAVING (positionCaseInsensitiveUTF8(consumer_id, ?) > 0 OR positionCaseInsensitiveUTF8(name, ?) > 0)`

func (s *Service) consumers(ctx context.Context, in *consumersInput) (*consumersOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	order, ok := consumerSorts[in.Sort]
	if !ok {
		return nil, huma.Error422UnprocessableEntity("sort must be one of requests, errors, last_seen")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 100
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
		where += " AND consumer_group = ?"
		args = append(args, in.Group)
	}
	having, hargs := "", []any{}
	if in.Search != "" {
		having, hargs = consumerSearch, []any{in.Search, in.Search}
	}

	qctx, cancel := queryCtx(ctx)
	defer cancel()

	// One page of the range's consumers in sort order.
	rows, err := s.ch.Query(qctx, `
		SELECT consumer_id, argMax(consumer_name, timestamp) AS name, `+latestGroup+` AS grp,
		       `+rawSplit+`, countIf(status_code >= 400) AS errs, max(timestamp) AS last_ts
		FROM api_requests WHERE `+where+`
		GROUP BY consumer_id`+having+` ORDER BY `+order+`, consumer_id LIMIT ? OFFSET ?`,
		append(append(append([]any{}, args...), hargs...), limit, in.Offset)...)
	if err != nil {
		return nil, internalError("consumers", err)
	}
	ids := []string{}
	for rows.Next() {
		var (
			c    consumerRow
			errs uint64
			last time.Time
		)
		if err := rows.Scan(&c.ConsumerID, &c.ConsumerName, &c.ConsumerGroup, &c.Requests, &c.Successful, &c.ClientErrors, &c.ServerErrors, &errs, &last); err != nil {
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
	}

	// Consumers matching group and search, across all pages.
	if err := s.ch.QueryRow(qctx, `
		SELECT count() FROM (SELECT consumer_id, argMax(consumer_name, timestamp) AS name
		FROM api_requests WHERE `+where+` GROUP BY consumer_id`+having+`)`,
		append(append([]any{}, args...), hargs...)...).Scan(&b.Total); err != nil {
		return nil, internalError("consumers total", err)
	}

	// Requests of the range's identified consumers by outcome.
	if err := s.ch.QueryRow(qctx, `SELECT `+rawSplit+` FROM api_requests WHERE `+where, args...).
		Scan(&b.Totals.Requests, &b.Totals.Successful, &b.Totals.ClientErrors, &b.Totals.ServerErrors); err != nil {
		return nil, internalError("consumers totals", err)
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

	spark, err := s.sparklines(ctx, w, "consumer_id", where+" AND has(?, consumer_id)", append(append([]any{}, args...), ids), ids)
	if err != nil {
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

// sparklines counts requests per bucket of w for each of keys, a value of
// column (consumer_id or consumer_group, never input). where and args select
// the rows; every key gets a zero-filled series.
func (s *Service) sparklines(ctx context.Context, w window, column, where string, args []any, keys []string) (map[string][]uint64, error) {
	n := int(w.to.Sub(w.from) / w.bucket)
	spark := make(map[string][]uint64, len(keys))
	for _, k := range keys {
		spark[k] = make([]uint64, n)
	}
	// The bucket width comes from the fixed ranges map, never from input.
	rows, err := s.ch.Query(ctx, fmt.Sprintf(`
		SELECT %[1]s, toDateTime(toStartOfInterval(timestamp, INTERVAL %[2]d SECOND), 'UTC') AS t, count()
		FROM api_requests WHERE %[3]s
		GROUP BY %[1]s, t`, column, int(w.bucket.Seconds()), where), args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			k string
			t time.Time
			c uint64
		)
		if err := rows.Scan(&k, &t, &c); err != nil {
			return nil, err
		}
		if i := int(t.Sub(w.from) / w.bucket); i >= 0 && i < n && spark[k] != nil {
			spark[k][i] = c
		}
	}
	return spark, rows.Err()
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

	// The SDK group: the latest non-empty one the consumer reported in the range.
	if err := s.ch.QueryRow(qctx, `SELECT `+latestGroup+` FROM api_requests WHERE `+where, args...).Scan(&b.ConsumerGroup); err != nil {
		return nil, internalError("consumer group", err)
	}
	if b.TopEndpoints, err = s.consumerEndpoints(qctx, where, args); err != nil {
		return nil, err
	}
	if b.RecentRequests, err = s.recentRequests(qctx, where, args, in.Limit, in.Offset); err != nil {
		return nil, err
	}
	if b.RecentErrors, err = s.recentRequests(qctx, where+" AND status_code >= 400", args, in.Limit, in.Offset); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Service) consumerEndpoints(ctx context.Context, where string, args []any) ([]consumerEndpoint, error) {
	rows, err := s.ch.Query(ctx, `
		SELECT method, path, `+rawSplit+`
		FROM api_requests WHERE `+where+`
		GROUP BY method, path ORDER BY n DESC, path, method LIMIT ?`, append(append([]any{}, args...), maxTopEndpoints)...)
	if err != nil {
		return nil, internalError("consumer endpoints", err)
	}
	defer func() { _ = rows.Close() }()
	out := []consumerEndpoint{}
	for rows.Next() {
		var e consumerEndpoint
		if err := rows.Scan(&e.Method, &e.Path, &e.Requests, &e.Successful, &e.ClientErrors, &e.ServerErrors); err != nil {
			return nil, internalError("consumer endpoints", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("consumer endpoints", err)
	}
	return out, nil
}

func (s *Service) recentRequests(ctx context.Context, where string, args []any, limit, offset int) ([]requestRow, error) {
	if limit <= 0 {
		limit = maxRecent
	}
	rows, err := s.ch.Query(ctx, `
		SELECT timestamp, app_id, method, path, raw_path, status_code, response_time_ms, request_size, response_size,
		       environment, ip_address, consumer_id, consumer_name, consumer_group, sampled, trace_id, span_id
		FROM api_requests WHERE `+where+`
		ORDER BY timestamp DESC, trace_id DESC LIMIT ? OFFSET ?`, append(append([]any{}, args...), limit, offset)...)
	if err != nil {
		return nil, internalError("consumer requests", err)
	}
	defer func() { _ = rows.Close() }()
	out := []requestRow{}
	for rows.Next() {
		var (
			r       requestRow
			app     uuid.UUID
			sampled uint8
			span    string
		)
		if err := rows.Scan(&r.Timestamp, &app, &r.Method, &r.Path, &r.RawPath, &r.StatusCode, &r.ResponseTimeMs,
			&r.RequestSize, &r.ResponseSize, &r.Environment, &r.IPAddress, &r.ConsumerID, &r.ConsumerName,
			&r.ConsumerGroup, &sampled, &r.TraceID, &span); err != nil {
			return nil, internalError("consumer requests", err)
		}
		r.AppID, r.Sampled = app.String(), sampled != 0
		r.ID = requestID{ms: r.Timestamp.UnixMilli(), traceID: r.TraceID, spanID: span}.encode()
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("consumer requests", err)
	}
	return out, nil
}
