package query

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Request timeline (#587): the filtered request log counted per time bucket
// and split by status class, for the bar chart above the Explore log. It
// reads api_requests with the request log's own filters, so every bar counts
// exactly the rows the log would list for its time.

// maxTimelineBuckets bounds the bars of one timeline.
const maxTimelineBuckets = 100

// timelineSteps are the bucket widths a timeline picks from, finest first.
var timelineSteps = []time.Duration{
	time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 15 * time.Second, 30 * time.Second,
	time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 15 * time.Minute, 30 * time.Minute,
	time.Hour, 2 * time.Hour, 3 * time.Hour, 6 * time.Hour, 12 * time.Hour, 24 * time.Hour,
}

// timelineStep is the finest bucket width that draws span in at most
// maxTimelineBuckets bars.
func timelineStep(span time.Duration) time.Duration {
	for _, s := range timelineSteps {
		if span <= s*maxTimelineBuckets {
			return s
		}
	}
	return timelineSteps[len(timelineSteps)-1]
}

type requestTimelineInput struct {
	RangeInput
	From            time.Time `query:"from" doc:"Start of the window (RFC 3339, inclusive); clamped to the range."`
	To              time.Time `query:"to" doc:"End of the window (RFC 3339, exclusive); clamped to the range."`
	ConsumerID      string    `query:"consumer_id" maxLength:"256" doc:"As in GET /api/v1/requests."`
	ConsumerGroup   string    `query:"consumer_group" maxLength:"256" doc:"As in GET /api/v1/requests."`
	IP              string    `query:"ip" maxLength:"64" doc:"As in GET /api/v1/requests."`
	Method          string    `query:"method" pattern:"^[A-Za-z]{1,16}$" doc:"As in GET /api/v1/requests."`
	Path            string    `query:"path" maxLength:"1024" doc:"As in GET /api/v1/requests."`
	URLContains     string    `query:"url_contains" maxLength:"1024" doc:"As in GET /api/v1/requests."`
	PayloadContains string    `query:"payload_contains" maxLength:"1024" doc:"As in GET /api/v1/requests."`
	RequestSizeMin  uint64    `query:"request_size_min" doc:"As in GET /api/v1/requests."`
	RequestSizeMax  uint64    `query:"request_size_max" doc:"As in GET /api/v1/requests."`
	ResponseSizeMin uint64    `query:"response_size_min" doc:"As in GET /api/v1/requests."`
	ResponseSizeMax uint64    `query:"response_size_max" doc:"As in GET /api/v1/requests."`
	Status          string    `query:"status" maxLength:"256" default:"all" doc:"As in GET /api/v1/requests."`
	LatencyMin      float64   `query:"latency_min" minimum:"0" doc:"As in GET /api/v1/requests."`
	LatencyMax      float64   `query:"latency_max" minimum:"0" doc:"As in GET /api/v1/requests."`
	Sampled         string    `query:"sampled" enum:"true,false" doc:"As in GET /api/v1/requests."`

	hasRequestSizeMax, hasResponseSizeMax, hasLatencyMax bool
}

// Resolve records which upper bounds the request sent.
func (in *requestTimelineInput) Resolve(ctx huma.Context) []error {
	u := ctx.URL()
	q := u.Query()
	in.hasRequestSizeMax = q.Has("request_size_max")
	in.hasResponseSizeMax = q.Has("response_size_max")
	in.hasLatencyMax = q.Has("latency_max")
	return nil
}

// filter is the request log input with the same filters.
func (in *requestTimelineInput) filter() *requestsInput {
	return &requestsInput{
		ConsumerID: in.ConsumerID, ConsumerGroup: in.ConsumerGroup, IP: in.IP, Method: in.Method, Path: in.Path,
		URLContains: in.URLContains, PayloadContains: in.PayloadContains,
		RequestSizeMin: in.RequestSizeMin, RequestSizeMax: in.RequestSizeMax,
		ResponseSizeMin: in.ResponseSizeMin, ResponseSizeMax: in.ResponseSizeMax,
		Status: in.Status, LatencyMin: in.LatencyMin, LatencyMax: in.LatencyMax, Sampled: in.Sampled,
		hasRequestSizeMax: in.hasRequestSizeMax, hasResponseSizeMax: in.hasResponseSizeMax, hasLatencyMax: in.hasLatencyMax,
	}
}

type timelineBucket struct {
	TS           time.Time `json:"ts" doc:"Start of the bucket."`
	Requests     uint64    `json:"requests" doc:"Requests in the bucket."`
	Successful   uint64    `json:"successful" doc:"Status below 400."`
	ClientErrors uint64    `json:"client_errors" doc:"Status 400-499."`
	ServerErrors uint64    `json:"server_errors" doc:"Status 500 and above."`
}

type requestTimelineOutput struct {
	Body struct {
		From          time.Time        `json:"from" doc:"Start of the window (inclusive)."`
		To            time.Time        `json:"to" doc:"End of the window (exclusive)."`
		BucketSeconds int              `json:"bucket_seconds" doc:"Width of each series bucket, in seconds."`
		Buckets       []timelineBucket `json:"buckets" doc:"Oldest first, every bucket of the window, empty ones with zeros. The first and last may extend past the window; they count only rows inside it."`
	}
}

// timelineBuckets lists the bucket starts covering [from, to), aligned to
// multiples of step since the Unix epoch.
func timelineBuckets(from, to time.Time, step time.Duration) []time.Time {
	out := []time.Time{}
	for t := from.Truncate(step); t.Before(to); t = t.Add(step) {
		out = append(out, t.UTC())
	}
	return out
}

func (s *Service) requestTimeline(ctx context.Context, in *requestTimelineInput) (*requestTimelineOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	from, to, err := narrowWindow(w, in.From, in.To)
	if err != nil {
		return nil, err
	}
	step := timelineStep(to.Sub(from))
	seconds := int64(step / time.Second)
	where, args := tenantFilter(p.ProjectID, in.Env)
	clauses, args, err := requestFilter(in.filter(), []string{where, "timestamp >= ?", "timestamp < ?"}, append(args, from, to))
	if err != nil {
		return nil, err
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	// seconds comes from timelineSteps, never from input.
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toUInt32(intDiv(toUnixTimestamp(timestamp), %d) * %d) AS ts,
		       count(), countIf(status_code < 400), countIf(status_code >= 400 AND status_code < 500), countIf(status_code >= 500)
		FROM api_requests WHERE %s
		GROUP BY ts`, seconds, seconds, strings.Join(clauses, " AND ")), args...)
	if err != nil {
		return nil, internalError("request timeline", err)
	}
	defer func() { _ = rows.Close() }()
	got := map[int64]timelineBucket{}
	for rows.Next() {
		var (
			ts uint32
			b  timelineBucket
		)
		if err := rows.Scan(&ts, &b.Requests, &b.Successful, &b.ClientErrors, &b.ServerErrors); err != nil {
			return nil, internalError("request timeline", err)
		}
		got[int64(ts)] = b
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("request timeline", err)
	}
	out := &requestTimelineOutput{}
	out.Body.From, out.Body.To, out.Body.BucketSeconds = from, to, int(seconds)
	out.Body.Buckets = []timelineBucket{}
	for _, t := range timelineBuckets(from, to, step) {
		b := got[t.Unix()]
		b.TS = t
		out.Body.Buckets = append(out.Body.Buckets, b)
	}
	return out, nil
}
