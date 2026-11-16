package query

import (
	"context"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Consumer group traffic: the consumer groups the SDK reports
// (consumer_group on each request, e.g. the company or plan a user belongs
// to), each with its requests by outcome, distinct consumers, last request
// and a sparkline in the range. A request counts towards the group it was
// tagged with, so a consumer that changed group shows up in both.

type consumerGroupTrafficInput struct {
	RangeInput
	Search string `query:"search" maxLength:"256" doc:"Only groups whose name contains this text, ignoring case."`
	Sort   string `query:"sort" enum:"requests,errors,consumers,last_seen" default:"requests" doc:"Order of groups, largest or latest first: requests, errors (4xx and 5xx), consumers or last_seen."`
	Limit  int    `query:"limit" minimum:"1" maximum:"500" default:"50" doc:"Most groups to list."`
	Offset int    `query:"offset" minimum:"0" maximum:"100000" default:"0" doc:"Groups to skip, for paging. Past the end answers an empty page with the real total."`
}

type consumerGroupTraffic struct {
	Group     string    `json:"group" doc:"The consumer group as the SDK reported it."`
	Consumers uint64    `json:"consumers" doc:"Distinct identified consumers with requests tagged with the group in the range."`
	LastSeen  time.Time `json:"last_seen" doc:"Last request tagged with the group in the range."`
	StatusSplit
	Sparkline []uint64 `json:"sparkline" doc:"Requests per bucket of the range (bucket_seconds wide), oldest first, zero-filled."`
}

type consumerGroupTrafficOutput struct {
	Body struct {
		Range         string                 `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From          time.Time              `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To            time.Time              `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		BucketSeconds int                    `json:"bucket_seconds" doc:"Width of each sparkline bucket, in seconds."`
		Total         uint64                 `json:"total" doc:"Groups matching search in the range, across all pages."`
		Groups        []consumerGroupTraffic `json:"groups" doc:"One page of groups (limit, offset), in sort order."`
	}
}

// groupSorts maps the sort parameter to an ORDER BY over the aliases of the
// group query. Queries take the clause from here, never from input.
var groupSorts = map[string]string{
	"":          "n DESC",
	"requests":  "n DESC",
	"errors":    "errs DESC, n DESC",
	"consumers": "users DESC, n DESC",
	"last_seen": "last_ts DESC",
}

func registerConsumerGroupTraffic(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-consumer-group-traffic",
		Method:      "GET",
		Path:        "/api/v1/consumer-groups",
		Summary:     "Consumer groups the SDK reports, with their traffic",
		Description: "Each consumer group the SDK reported in the range (consumer_group on a request, such as the company or plan a user " +
			"belongs to), with its requests by outcome, distinct consumers, last request and a sparkline, most requests first. " +
			"Requests without a group are left out." + readAccess,
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.consumerGroupTraffic)
}

func (s *Service) consumerGroupTraffic(ctx context.Context, in *consumerGroupTrafficInput) (*consumerGroupTrafficOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	order, ok := groupSorts[in.Sort]
	if !ok {
		return nil, huma.Error422UnprocessableEntity("sort must be one of requests, errors, consumers, last_seen")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 50
	}
	out := &consumerGroupTrafficOutput{}
	b := &out.Body
	b.Range, b.From, b.To, b.BucketSeconds = w.name, w.from, w.to, int(w.bucket.Seconds())
	b.Groups = []consumerGroupTraffic{}

	where, args := tenantFilter(p.ProjectID, in.Env)
	where += " AND timestamp >= ? AND timestamp < ? AND consumer_group != ''"
	args = append(args, w.from, w.to)
	if in.Search != "" {
		where += " AND positionCaseInsensitiveUTF8(consumer_group, ?) > 0"
		args = append(args, in.Search)
	}

	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, `
		SELECT consumer_group, `+rawSplit+`, countIf(status_code >= 400) AS errs,
		       uniqExactIf(consumer_id, consumer_id != '') AS users, max(timestamp) AS last_ts
		FROM api_requests WHERE `+where+`
		GROUP BY consumer_group ORDER BY `+order+`, consumer_group LIMIT ? OFFSET ?`,
		append(append([]any{}, args...), limit, in.Offset)...)
	if err != nil {
		return nil, internalError("consumer groups", err)
	}
	names := []string{}
	for rows.Next() {
		var (
			g    consumerGroupTraffic
			errs uint64
		)
		if err := rows.Scan(&g.Group, &g.Requests, &g.Successful, &g.ClientErrors, &g.ServerErrors, &errs, &g.Consumers, &g.LastSeen); err != nil {
			_ = rows.Close()
			return nil, internalError("consumer groups", err)
		}
		g.LastSeen = g.LastSeen.UTC()
		b.Groups = append(b.Groups, g)
		names = append(names, g.Group)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("consumer groups", err)
	}

	if err := s.ch.QueryRow(qctx, `SELECT uniqExact(consumer_group) FROM api_requests WHERE `+where, args...).Scan(&b.Total); err != nil {
		return nil, internalError("consumer groups total", err)
	}
	if len(names) == 0 {
		return out, nil
	}
	spark, err := s.sparklines(qctx, w, "consumer_group", where+" AND has(?, consumer_group)", append(append([]any{}, args...), names), names)
	if err != nil {
		return nil, internalError("consumer groups sparkline", err)
	}
	for i := range b.Groups {
		b.Groups[i].Sparkline = spark[b.Groups[i].Group]
	}
	return out, nil
}
