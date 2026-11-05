package query

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// Errors dashboard, status-centric (Apitally's errors view): the error
// status codes of a project over time and as a table, and the detail of one
// status code — occurrences, affected consumers, last seen, frequency, a
// per-endpoint breakdown pointing at the endpoint's validation errors and
// exceptions, and a per-consumer breakdown.
//
// /api/v1/errors stays the endpoint x status list; these operations group by
// status code across endpoints. Like it they read raw api_requests: a status
// code the endpoint's settings mark as expected is no error and is left out,
// and excluded endpoints are left out entirely.

// Limits of the error status tables.
const (
	maxStatusEndpoints = 50
	maxStatusConsumers = 100
)

func registerErrorStatus(api huma.API, s *Service) {
	op := func(id, path, summary string) huma.Operation {
		return huma.Operation{OperationID: id, Method: http.MethodGet, Path: path, Summary: summary, Tags: []string{"Dashboard"}, Security: security}
	}
	huma.Register(api, op("get-error-statuses", "/api/v1/errors/status",
		"Errors dashboard: client/server errors and each error status code over time, and status codes by count"), s.errorStatuses)
	huma.Register(api, op("get-error-status", "/api/v1/errors/status/{code}",
		"Error status detail: occurrences, affected consumers, last seen, frequency, endpoint and consumer breakdowns"), s.errorStatus)
}

// errorScope is the WHERE clause of the raw rows a dashboard read counts in
// a window (excluded endpoints left out), and the predicate matching the
// rows among them that are errors (expected status codes left out). The
// isError arguments are separate so the predicate can sit anywhere.
type errorScope struct {
	project uuid.UUID
	where   string
	args    []any
	isError string
	errArgs []any
}

func (s *Service) errorScope(ctx context.Context, in *RangeInput, w window) (errorScope, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return errorScope{}, err
	}
	rules, err := s.endpointRules(ctx, p.ProjectID)
	if err != nil {
		return errorScope{}, err
	}
	where, args := rules.withoutExcluded(tenantFilter(p.ProjectID, in.Env))
	sc := errorScope{
		project: p.ProjectID,
		where:   where + " AND timestamp >= ? AND timestamp < ?",
		args:    append(args, w.from, w.to),
		isError: "status_code >= 400",
	}
	if pred, pargs := rules.expectedPredicate(); pred != "" {
		sc.isError, sc.errArgs = "status_code >= 400 AND NOT "+pred, pargs
	}
	return sc, nil
}

// buckets lists the bucket starts of w.
func buckets(w window) []time.Time {
	out := make([]time.Time, 0, int(w.to.Sub(w.from)/w.bucket))
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		out = append(out, t)
	}
	return out
}

// ---------------------------------------------------------------- overview

type errorStatusPoint struct {
	TS time.Time `json:"ts" doc:"Start of the bucket."`
	ErrorSplit
}

type errorStatusSeries struct {
	StatusCode uint16   `json:"status_code"`
	Counts     []uint64 `json:"counts" doc:"Occurrences per bucket, aligned with points."`
}

type errorStatusRow struct {
	StatusCode uint16    `json:"status_code"`
	Count      uint64    `json:"count"`
	Share      float64   `json:"share" doc:"count / requests of the range."`
	Endpoints  uint64    `json:"endpoints" doc:"Distinct endpoints (method + route) that answered with it."`
	Consumers  uint64    `json:"consumers" doc:"Distinct consumers that got it."`
	FirstSeen  time.Time `json:"first_seen"`
	LastSeen   time.Time `json:"last_seen"`
}

type errorStatusesOutput struct {
	Body struct {
		Range         string              `json:"range"`
		From          time.Time           `json:"from"`
		To            time.Time           `json:"to"`
		BucketSeconds int                 `json:"bucket_seconds"`
		Summary       ErrorSplit          `json:"summary"`
		Points        []errorStatusPoint  `json:"points" doc:"Requests, 4xx and 5xx errors per bucket of the range, zero-filled."`
		Series        []errorStatusSeries `json:"series" doc:"Occurrences of each error status code per bucket, in statuses order."`
		Statuses      []errorStatusRow    `json:"statuses" doc:"Error status codes (400 and above) by count, most frequent first; expected status codes of each endpoint left out."`
	}
}

func (s *Service) errorStatuses(ctx context.Context, in *RangeInput) (*errorStatusesOutput, error) {
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	sc, err := s.errorScope(ctx, in, w)
	if err != nil {
		return nil, err
	}
	seconds := int(w.bucket.Seconds())
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	out := &errorStatusesOutput{}
	b := &out.Body
	b.Range, b.From, b.To, b.BucketSeconds = w.name, w.from, w.to, seconds

	// code is the status code of an error row and 0 for every other row,
	// so one pass counts the requests and each error code per bucket. The
	// bucket width comes from the fixed ranges map, never from input.
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toStartOfInterval(timestamp, INTERVAL %d SECOND) AS t, if(%s, status_code, 0) AS code, count()
		FROM api_requests WHERE %s GROUP BY t, code ORDER BY t, code`, seconds, sc.isError, sc.where),
		append(append([]any{}, sc.errArgs...), sc.args...)...)
	if err != nil {
		return nil, internalError("error status trend", err)
	}
	split := map[int64]ErrorSplit{}
	byCode := map[uint16]map[int64]uint64{}
	for rows.Next() {
		var (
			t    time.Time
			code uint16
			n    uint64
		)
		if err := rows.Scan(&t, &code, &n); err != nil {
			_ = rows.Close()
			return nil, internalError("error status trend", err)
		}
		k := t.UTC().Unix()
		sp := split[k]
		sp.Requests += n
		switch {
		case code >= 500:
			sp.ServerErrors += n
		case code >= 400:
			sp.ClientErrors += n
		}
		split[k] = sp
		if code != 0 {
			if byCode[code] == nil {
				byCode[code] = map[int64]uint64{}
			}
			byCode[code][k] += n
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("error status trend", err)
	}
	ts := buckets(w)
	b.Points = make([]errorStatusPoint, 0, len(ts))
	for _, t := range ts {
		sp := split[t.Unix()]
		sp.rates()
		b.Points = append(b.Points, errorStatusPoint{TS: t, ErrorSplit: sp})
		b.Summary.Requests += sp.Requests
		b.Summary.ClientErrors += sp.ClientErrors
		b.Summary.ServerErrors += sp.ServerErrors
	}
	b.Summary.rates()

	srows, err := s.ch.Query(qctx, `
		SELECT status_code, count() AS n, uniq(method, path), uniqIf(consumer_id, consumer_id != ''), min(timestamp), max(timestamp)
		FROM api_requests WHERE `+sc.where+` AND `+sc.isError+`
		GROUP BY status_code ORDER BY n DESC, status_code`, append(append([]any{}, sc.args...), sc.errArgs...)...)
	if err != nil {
		return nil, internalError("error statuses", err)
	}
	defer func() { _ = srows.Close() }()
	b.Statuses, b.Series = []errorStatusRow{}, []errorStatusSeries{}
	for srows.Next() {
		var r errorStatusRow
		if err := srows.Scan(&r.StatusCode, &r.Count, &r.Endpoints, &r.Consumers, &r.FirstSeen, &r.LastSeen); err != nil {
			return nil, internalError("error statuses", err)
		}
		if b.Summary.Requests > 0 {
			r.Share = float64(r.Count) / float64(b.Summary.Requests)
		}
		b.Statuses = append(b.Statuses, r)
		counts := make([]uint64, len(ts))
		for i, t := range ts {
			counts[i] = byCode[r.StatusCode][t.Unix()]
		}
		b.Series = append(b.Series, errorStatusSeries{StatusCode: r.StatusCode, Counts: counts})
	}
	return out, srows.Err()
}

// ---------------------------------------------------------------- detail

type errorStatusInput struct {
	RangeInput
	Code int `path:"code" minimum:"400" maximum:"599" doc:"Error status code, 400 to 599."`
}

type errorStatusCountPoint struct {
	TS    time.Time `json:"ts" doc:"Start of the bucket."`
	Count uint64    `json:"count"`
}

type errorStatusEndpoint struct {
	Method           string    `json:"method"`
	Path             string    `json:"path" doc:"Route template; its errors tab is GET /api/v1/endpoints/{method}/{path}/errors."`
	Count            uint64    `json:"count"`
	Consumers        uint64    `json:"consumers" doc:"Distinct consumers that got the status code from this endpoint."`
	LastSeen         time.Time `json:"last_seen"`
	ValidationErrors uint64    `json:"validation_errors" doc:"Occurrences that carried validation errors (detail in the endpoint's errors tab)."`
	Exceptions       uint64    `json:"exceptions" doc:"Server exceptions logged for occurrences of the status code (detail in the endpoint's errors tab)."`
}

type errorStatusConsumer struct {
	ConsumerID   string    `json:"consumer_id"`
	ConsumerName string    `json:"consumer_name" doc:"Most recently reported name of the consumer."`
	Count        uint64    `json:"count"`
	Share        float64   `json:"share" doc:"count / occurrences."`
	FirstSeen    time.Time `json:"first_seen"`
	LastSeen     time.Time `json:"last_seen"`
}

type errorStatusOutput struct {
	Body struct {
		StatusCode    int                     `json:"status_code"`
		Range         string                  `json:"range"`
		From          time.Time               `json:"from"`
		To            time.Time               `json:"to"`
		BucketSeconds int                     `json:"bucket_seconds"`
		Occurrences   uint64                  `json:"occurrences" doc:"Requests answered with the status code where it is not expected for the endpoint."`
		Requests      uint64                  `json:"requests" doc:"All requests of the range."`
		Share         float64                 `json:"share" doc:"occurrences / requests, 0 without requests."`
		PerHour       float64                 `json:"per_hour" doc:"Frequency: occurrences per hour over the range."`
		Consumers     uint64                  `json:"consumers" doc:"Affected consumers: distinct consumers that got the status code."`
		Anonymous     uint64                  `json:"anonymous" doc:"Occurrences from requests without a consumer."`
		Endpoints     uint64                  `json:"endpoints" doc:"Distinct endpoints that answered with the status code."`
		FirstSeen     *time.Time              `json:"first_seen" required:"true" nullable:"true" doc:"First occurrence in the range; null without occurrences."`
		LastSeen      *time.Time              `json:"last_seen" required:"true" nullable:"true" doc:"Last occurrence in the range; null without occurrences."`
		Points        []errorStatusCountPoint `json:"points" doc:"Occurrences per bucket of the range, zero-filled."`
		EndpointList  []errorStatusEndpoint   `json:"endpoint_breakdown" doc:"Occurrences per endpoint, most frequent first (at most 50)."`
		ConsumerList  []errorStatusConsumer   `json:"consumer_breakdown" doc:"Occurrences per identified consumer, most frequent first (at most 100)."`
	}
}

func (s *Service) errorStatus(ctx context.Context, in *errorStatusInput) (*errorStatusOutput, error) {
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	sc, err := s.errorScope(ctx, &in.RangeInput, w)
	if err != nil {
		return nil, err
	}
	seconds := int(w.bucket.Seconds())
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	out := &errorStatusOutput{}
	b := &out.Body
	b.StatusCode, b.Range, b.From, b.To, b.BucketSeconds = in.Code, w.name, w.from, w.to, seconds
	b.Points, b.EndpointList, b.ConsumerList = []errorStatusCountPoint{}, []errorStatusEndpoint{}, []errorStatusConsumer{}

	// match selects the occurrences: rows of the code that are errors.
	match := sc.where + " AND status_code = ? AND " + sc.isError
	margs := append(append(append([]any{}, sc.args...), in.Code), sc.errArgs...)

	var first, last time.Time
	if err := s.ch.QueryRow(qctx, `
		SELECT count(), countIf(consumer_id = ''), uniqIf(consumer_id, consumer_id != ''), uniq(method, path), min(timestamp), max(timestamp)
		FROM api_requests WHERE `+match, margs...).
		Scan(&b.Occurrences, &b.Anonymous, &b.Consumers, &b.Endpoints, &first, &last); err != nil {
		return nil, internalError("error status summary", err)
	}
	if err := s.ch.QueryRow(qctx, `SELECT count() FROM api_requests WHERE `+sc.where, sc.args...).Scan(&b.Requests); err != nil {
		return nil, internalError("error status requests", err)
	}
	if b.Requests > 0 {
		b.Share = float64(b.Occurrences) / float64(b.Requests)
	}
	b.PerHour = float64(b.Occurrences) / w.to.Sub(w.from).Hours()
	if b.Occurrences > 0 {
		b.FirstSeen, b.LastSeen = &first, &last
	}

	// The bucket width comes from the fixed ranges map, never from input.
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toStartOfInterval(timestamp, INTERVAL %d SECOND) AS t, count()
		FROM api_requests WHERE %s GROUP BY t ORDER BY t`, seconds, match), margs...)
	if err != nil {
		return nil, internalError("error status trend", err)
	}
	got := map[int64]uint64{}
	for rows.Next() {
		var (
			t time.Time
			n uint64
		)
		if err := rows.Scan(&t, &n); err != nil {
			_ = rows.Close()
			return nil, internalError("error status trend", err)
		}
		got[t.UTC().Unix()] = n
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("error status trend", err)
	}
	for _, t := range buckets(w) {
		b.Points = append(b.Points, errorStatusCountPoint{TS: t, Count: got[t.Unix()]})
	}
	if b.Occurrences == 0 {
		return out, nil
	}

	if b.EndpointList, err = s.errorStatusEndpoints(qctx, match, margs); err != nil {
		return nil, err
	}
	if err := s.errorStatusExceptions(qctx, sc.project, in, w, b.EndpointList); err != nil {
		return nil, err
	}

	crows, err := s.ch.Query(qctx, `
		SELECT consumer_id, argMax(consumer_name, timestamp), count() AS n, min(timestamp), max(timestamp)
		FROM api_requests WHERE `+match+` AND consumer_id != ''
		GROUP BY consumer_id ORDER BY n DESC, consumer_id LIMIT ?`, append(margs, maxStatusConsumers)...)
	if err != nil {
		return nil, internalError("error status consumers", err)
	}
	defer func() { _ = crows.Close() }()
	for crows.Next() {
		var c errorStatusConsumer
		if err := crows.Scan(&c.ConsumerID, &c.ConsumerName, &c.Count, &c.FirstSeen, &c.LastSeen); err != nil {
			return nil, internalError("error status consumers", err)
		}
		c.Share = float64(c.Count) / float64(b.Occurrences)
		b.ConsumerList = append(b.ConsumerList, c)
	}
	return out, crows.Err()
}

func (s *Service) errorStatusEndpoints(ctx context.Context, match string, args []any) ([]errorStatusEndpoint, error) {
	rows, err := s.ch.Query(ctx, `
		SELECT method, path, count() AS n, uniqIf(consumer_id, consumer_id != ''), max(timestamp), countIf(validation_errors != '')
		FROM api_requests WHERE `+match+`
		GROUP BY method, path ORDER BY n DESC, path, method LIMIT ?`, append(append([]any{}, args...), maxStatusEndpoints)...)
	if err != nil {
		return nil, internalError("error status endpoints", err)
	}
	defer func() { _ = rows.Close() }()
	out := []errorStatusEndpoint{}
	for rows.Next() {
		var e errorStatusEndpoint
		if err := rows.Scan(&e.Method, &e.Path, &e.Count, &e.Consumers, &e.LastSeen, &e.ValidationErrors); err != nil {
			return nil, internalError("error status endpoints", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// errorStatusExceptions fills the exception counts of endpoints: the
// exception records the SDKs logged for requests answered with the code.
func (s *Service) errorStatusExceptions(ctx context.Context, project uuid.UUID, in *errorStatusInput, w window, endpoints []errorStatusEndpoint) error {
	where, args := tenantFilter(project, in.Env)
	rows, err := s.ch.Query(ctx, `
		SELECT endpoint_method, endpoint_path, count()
		FROM api_logs WHERE `+where+` AND timestamp >= ? AND timestamp < ?
		  AND level IN ('ERROR', 'CRITICAL') AND logger_name = ? AND status_code = ?
		GROUP BY endpoint_method, endpoint_path`, append(args, w.from, w.to, exceptionLogger, in.Code)...)
	if err != nil {
		return internalError("error status exceptions", err)
	}
	defer func() { _ = rows.Close() }()
	idx := make(map[string]int, len(endpoints))
	for i, e := range endpoints {
		idx[e.Method+" "+e.Path] = i
	}
	for rows.Next() {
		var (
			method, path string
			n            uint64
		)
		if err := rows.Scan(&method, &path, &n); err != nil {
			return internalError("error status exceptions", err)
		}
		if i, ok := idx[method+" "+path]; ok {
			endpoints[i].Exceptions += n
		}
	}
	return rows.Err()
}
