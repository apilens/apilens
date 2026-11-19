package query

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Request facets (#1052): how many requests of the filtered log carry each
// value of one field, busiest first, for the counts beside Explore's facet
// checkboxes. The field's own conditions are left out, so ticking one value
// never hides the others; every other filter applies, as on the log.

// maxFacetValues bounds the values of one facet page.
const maxFacetValues = 50

// maxFacetOffset bounds how far a facet pages ("Show more" in Explore).
const maxFacetOffset = 1000

// facetColumns are the facet fields: the expression each groups by and, for
// consumers, the name shown beside the id. Empty values are left out where
// they mean "none" (no consumer, no group).
var facetColumns = map[string]struct{ value, label, nonEmpty, search string }{
	"status":         {value: "toString(status_code)"},
	"method":         {value: "method"},
	"app":            {value: "toString(app_id)"},
	"env":            {value: "environment"},
	"path":           {value: "path", search: "path ILIKE ?"},
	"consumer":       {value: "consumer_id", label: "any(consumer_name)", nonEmpty: "consumer_id != ''", search: "(consumer_id ILIKE ? OR consumer_name ILIKE ?)"},
	"consumer_group": {value: "consumer_group", nonEmpty: "consumer_group != ''", search: "consumer_group ILIKE ?"},
}

func registerRequestFacets(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-request-facets", Method: http.MethodGet, Path: "/api/v1/requests/facets",
		Summary: "Request facets: requests per value of one field of the filtered request log",
		Description: "How many requests of the range carry each value of field (status code, method, app id, environment, route " +
			"template, consumer id or consumer group), most first, at most limit values. Takes the filters of list-requests; " +
			"the filter conditions on field itself are left out, so every value of the field is counted under the other filters. " +
			"search narrows path, consumer and consumer_group to values containing it, ignoring case. offset skips that many " +
			"values of the same order, so a long list pages; has_more says whether values follow this page." + readAccess,
		Tags: []string{"Dashboard"}, Security: security,
	}, s.requestFacets)
}

type requestFacetsInput struct {
	RangeInput
	Field  string    `query:"field" required:"true" enum:"status,method,app,env,path,consumer,consumer_group" doc:"The field to count values of."`
	Search string    `query:"search" maxLength:"256" doc:"Only values containing this text, ignoring case (path, consumer and consumer_group)."`
	Limit  int       `query:"limit" minimum:"1" maximum:"50" default:"50" doc:"Most values to list."`
	Offset int       `query:"offset" minimum:"0" maximum:"1000" default:"0" doc:"Values to skip, in the same order (most requests first, then by value), to page a long list."`
	From   time.Time `query:"from" doc:"Start of the window (RFC 3339, inclusive); clamped to the range."`
	To     time.Time `query:"to" doc:"End of the window (RFC 3339, exclusive); clamped to the range."`
	Filter []string  `query:"filter,explode" maxItems:"50" doc:"field:op:value conditions, as in GET /api/v1/requests; those on field are left out."`
}

type facetValue struct {
	Value string `json:"value" doc:"The value: a status code, method, app id, environment, route template, consumer id or group."`
	Label string `json:"label" doc:"The consumer's name for a consumer id; empty for every other field."`
	Count uint64 `json:"count" doc:"Requests with this value."`
}

type requestFacetsOutput struct {
	Body struct {
		Field   string       `json:"field" doc:"The field counted."`
		Values  []facetValue `json:"values" doc:"Most requests first, then by value."`
		HasMore bool         `json:"has_more" doc:"Whether more values follow this page (read them with offset)."`
	}
}

// facetQuery is the SQL counting values of field under clauses, and its
// args. It reads one value past limit, so the caller can tell has_more.
func facetQuery(field, search string, limit, offset int, clauses []string, args []any) (string, []any, error) {
	col, ok := facetColumns[field]
	if !ok {
		return "", nil, huma.Error422UnprocessableEntity(fmt.Sprintf("unknown facet field %q", field))
	}
	if col.nonEmpty != "" {
		clauses = append(clauses, col.nonEmpty)
	}
	if search = strings.TrimSpace(search); search != "" && col.search != "" {
		clauses = append(clauses, col.search)
		pat := likeContains(search)
		for range strings.Count(col.search, "?") {
			args = append(args, pat)
		}
	}
	label := "''"
	if col.label != "" {
		label = col.label
	}
	limit = min(max(limit, 1), maxFacetValues)
	offset = min(max(offset, 0), maxFacetOffset)
	// col comes from facetColumns, never from input.
	q := fmt.Sprintf(`SELECT %s AS v, %s AS l, count() AS n FROM api_requests WHERE %s GROUP BY v ORDER BY n DESC, v LIMIT ? OFFSET ?`,
		col.value, label, strings.Join(clauses, " AND "))
	return q, append(args, limit+1, offset), nil
}

func (s *Service) requestFacets(ctx context.Context, in *requestFacetsInput) (*requestFacetsOutput, error) {
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
	env := in.Env
	if in.Field == "env" {
		env = ""
	}
	where, args := tenantFilter(p.ProjectID, env)
	clauses, args, err := requestFilter(&requestsInput{Filter: withoutField(in.Filter, in.Field)}, []string{where, "timestamp >= ?", "timestamp < ?"}, append(args, from, to))
	if err != nil {
		return nil, err
	}
	limit := min(max(in.Limit, 1), maxFacetValues)
	q, args, err := facetQuery(in.Field, in.Search, limit, in.Offset, clauses, args)
	if err != nil {
		return nil, err
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, q, args...)
	if err != nil {
		return nil, internalError("request facets", err)
	}
	defer func() { _ = rows.Close() }()
	out := &requestFacetsOutput{}
	out.Body.Field = in.Field
	out.Body.Values = []facetValue{}
	for rows.Next() {
		var v facetValue
		if err := rows.Scan(&v.Value, &v.Label, &v.Count); err != nil {
			return nil, internalError("request facets", err)
		}
		out.Body.Values = append(out.Body.Values, v)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("request facets", err)
	}
	if len(out.Body.Values) > limit {
		out.Body.Values = out.Body.Values[:limit]
		out.Body.HasMore = true
	}
	return out, nil
}
