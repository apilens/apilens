package query

import (
	"context"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Anonymous callers (#989): the requests of a range the SDK did not tag with
// a consumer (consumer_id empty), counted by outcome, and the top callers
// among them by client IP and user agent, as stored with each request. The
// Consumers page shows them when no consumer is identified, so the traffic
// that flows is still attributable to someone while the SDK is not told who
// is calling.

// maxAnonymousCallers bounds the callers one read may list.
const maxAnonymousCallers = 100

type anonymousCallersInput struct {
	RangeInput
	WindowInput
	Limit int `query:"limit" minimum:"1" maximum:"100" default:"10" doc:"Most callers to list."`
}

type anonymousCaller struct {
	IPAddress string    `json:"ip_address" doc:"Client IP address as stored with the requests; empty when not captured."`
	UserAgent string    `json:"user_agent" doc:"User-Agent header as stored with the requests; empty when not captured."`
	LastSeen  time.Time `json:"last_seen" doc:"Last anonymous request from this IP and user agent in the range."`
	StatusSplit
}

type anonymousCallersOutput struct {
	Body struct {
		Range   string            `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From    time.Time         `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To      time.Time         `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		Totals  StatusSplit       `json:"totals" doc:"Requests in the range without a consumer, by outcome."`
		Callers []anonymousCaller `json:"callers" doc:"The client IP and user agent pairs with the most requests without a consumer in the range (at most limit), most requests first."`
	}
}

func registerAnonymousCallers(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-anonymous-callers",
		Method:      "GET",
		Path:        "/api/v1/anonymous-callers",
		Summary:     "Requests without a consumer, and their top callers by client IP and user agent",
		Description: "The requests of the range the SDK sent without a consumer, by outcome, and the client IP and user agent pairs " +
			"that made the most of them, with their last request. Requests with a consumer are left out." + readAccess,
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.anonymousCallers)
}

func (s *Service) anonymousCallers(ctx context.Context, in *anonymousCallersInput) (*anonymousCallersOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveTrafficWindow(in.Range, in.From, in.To, s.now())
	if err != nil {
		return nil, err
	}
	limit := in.Limit
	if limit <= 0 || limit > maxAnonymousCallers {
		limit = 10
	}
	out := &anonymousCallersOutput{}
	b := &out.Body
	b.Range, b.From, b.To = w.name, w.from, w.to
	b.Callers = []anonymousCaller{}

	where, args := tenantFilter(p.ProjectID, in.Env)
	where += " AND timestamp >= ? AND timestamp < ? AND consumer_id = ''"
	args = append(args, w.from, w.to)

	qctx, cancel := queryCtx(ctx)
	defer cancel()

	if err := s.ch.QueryRow(qctx, `SELECT `+rawSplit+` FROM api_requests WHERE `+where, args...).
		Scan(&b.Totals.Requests, &b.Totals.Successful, &b.Totals.ClientErrors, &b.Totals.ServerErrors); err != nil {
		return nil, internalError("anonymous totals", err)
	}
	if b.Totals.Requests == 0 {
		return out, nil
	}

	rows, err := s.ch.Query(qctx, `
		SELECT ip_address, user_agent, `+rawSplit+`, max(timestamp) AS last_ts
		FROM api_requests WHERE `+where+`
		GROUP BY ip_address, user_agent ORDER BY n DESC, last_ts DESC, ip_address, user_agent LIMIT ?`,
		append(append([]any{}, args...), limit)...)
	if err != nil {
		return nil, internalError("anonymous callers", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var c anonymousCaller
		if err := rows.Scan(&c.IPAddress, &c.UserAgent, &c.Requests, &c.Successful, &c.ClientErrors, &c.ServerErrors, &c.LastSeen); err != nil {
			return nil, internalError("anonymous callers", err)
		}
		c.LastSeen = c.LastSeen.UTC()
		b.Callers = append(b.Callers, c)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("anonymous callers", err)
	}
	return out, nil
}
