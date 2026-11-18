package query

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// Request log conditions (#1052): the repeatable `filter=field:op:value`
// parameter of the request log, its timeline, its facets and its exports,
// the same scheme the Explore URL carries. Each condition names a field of
// api_requests, an operator and a value:
//
//	path, url, consumer, consumer_group, ip, user_agent, trace_id
//	                         eq, neq, contains, ncontains
//	method, app, env         eq, neq
//	status                   eq, neq (a code 404, a class 4xx or a range 500-503)
//	latency, request_size, response_size
//	                         gt (at least), lt (at most), between (a-b, inclusive)
//	payload                  contains
//	sampled                  eq (true or false)
//
// Conditions of one field and operator combine the way a facet reads: the
// values of eq (and contains) are alternatives, any one matches; the values
// of neq (and ncontains) are all excluded. Everything else is ANDed, with
// each other and with the older one-value parameters.

// maxConditions bounds the conditions of one read.
const maxConditions = 50

// maxConditionValue bounds the value of one condition.
const maxConditionValue = 1024

// condition is one parsed `field:op:value`.
type condition struct {
	field, op, value string
}

// conditionOps are the operators each field takes.
var conditionOps = map[string][]string{
	"path":           {"eq", "neq", "contains", "ncontains"},
	"url":            {"eq", "neq", "contains", "ncontains"},
	"consumer":       {"eq", "neq", "contains", "ncontains"},
	"consumer_group": {"eq", "neq", "contains", "ncontains"},
	"ip":             {"eq", "neq", "contains", "ncontains"},
	"user_agent":     {"eq", "neq", "contains", "ncontains"},
	"trace_id":       {"eq", "neq", "contains", "ncontains"},
	"method":         {"eq", "neq"},
	"app":            {"eq", "neq"},
	"env":            {"eq", "neq"},
	"status":         {"eq", "neq"},
	"latency":        {"gt", "lt", "between"},
	"request_size":   {"gt", "lt", "between"},
	"response_size":  {"gt", "lt", "between"},
	"payload":        {"contains"},
	"sampled":        {"eq"},
}

// textColumns are the columns of the plain text fields.
var textColumns = map[string]string{
	"url": "raw_path", "consumer_group": "consumer_group", "ip": "ip_address", "user_agent": "user_agent", "trace_id": "trace_id",
}

// numberColumns are the columns of the numeric fields.
var numberColumns = map[string]string{
	"latency": "response_time_ms", "request_size": "request_size", "response_size": "response_size",
}

// filterDoc documents the filter parameter on every operation that takes it.
const filterDoc = "Repeatable field:op:value conditions, the Explore URL scheme. Fields and operators: path, url, consumer, " +
	"consumer_group, ip, user_agent and trace_id take eq, neq, contains and ncontains; method, app, env and status take eq and " +
	"neq (status values are codes 404, classes 4xx or ranges 500-503); latency (ms), request_size and response_size (bytes) take " +
	"gt (at least), lt (at most) and between (a-b); payload takes contains; sampled takes eq true or false. The values of one " +
	"field's eq or contains are alternatives; its neq and ncontains values are all excluded; everything else is ANDed."

// parseCondition reads one `field:op:value`; the value may itself hold colons.
func parseCondition(s string) (condition, error) {
	field, rest, ok := strings.Cut(s, ":")
	if !ok {
		return condition{}, fmt.Errorf("%q is not field:op:value", s)
	}
	op, value, ok := strings.Cut(rest, ":")
	if !ok {
		return condition{}, fmt.Errorf("%q is not field:op:value", s)
	}
	field, op = strings.ToLower(strings.TrimSpace(field)), strings.ToLower(strings.TrimSpace(op))
	ops, known := conditionOps[field]
	if !known {
		return condition{}, fmt.Errorf("unknown filter field %q", field)
	}
	if !slices.Contains(ops, op) {
		return condition{}, fmt.Errorf("filter field %s takes %s, not %q", field, strings.Join(ops, ", "), op)
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return condition{}, fmt.Errorf("filter %s:%s has no value", field, op)
	}
	if len(value) > maxConditionValue {
		return condition{}, fmt.Errorf("filter %s value is longer than %d bytes", field, maxConditionValue)
	}
	return condition{field: field, op: op, value: value}, nil
}

// parseConditions reads every condition, answering 422 on the first invalid one.
func parseConditions(raw []string) ([]condition, error) {
	if len(raw) > maxConditions {
		return nil, huma.Error422UnprocessableEntity(fmt.Sprintf("at most %d filter conditions", maxConditions))
	}
	out := make([]condition, 0, len(raw))
	for _, s := range raw {
		c, err := parseCondition(s)
		if err != nil {
			return nil, huma.Error422UnprocessableEntity("invalid filter: " + err.Error())
		}
		out = append(out, c)
	}
	return out, nil
}

// withoutField drops the conditions on field: a facet counts its own values
// under every other filter, so ticking one value never hides the others.
func withoutField(raw []string, field string) []string {
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		f, _, _ := strings.Cut(s, ":")
		if strings.EqualFold(strings.TrimSpace(f), field) {
			continue
		}
		out = append(out, s)
	}
	return out
}

// bound reads one numeric bound of a condition.
func bound(field, s string) (float64, error) {
	n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("filter %s takes a number of at least 0, not %q", field, s)
	}
	return n, nil
}

// conditionClause is the SQL of one condition, positive: eq, contains, gt,
// lt and between as they read; neq and ncontains as their eq and contains,
// which the caller negates.
func conditionClause(c condition) (string, []any, error) {
	positive := c.op
	switch c.op {
	case "neq":
		positive = "eq"
	case "ncontains":
		positive = "contains"
	}
	switch c.field {
	case "path":
		if positive == "contains" {
			pat := likeContains(c.value)
			return "(path ILIKE ? OR raw_path ILIKE ?)", []any{pat, pat}, nil
		}
		// As the path parameter: a route template matches exactly, any other path also the raw URLs containing it.
		if isRouteTemplate(c.value) {
			return "path = ?", []any{c.value}, nil
		}
		return "(path = ? OR raw_path ILIKE ?)", []any{c.value, likeContains(c.value)}, nil
	case "consumer":
		if positive == "contains" {
			pat := likeContains(c.value)
			return "(consumer_id ILIKE ? OR consumer_name ILIKE ?)", []any{pat, pat}, nil
		}
		return "(consumer_id = ? OR consumer_name = ?)", []any{c.value, c.value}, nil
	case "method":
		return "method = ?", []any{strings.ToUpper(c.value)}, nil
	case "app":
		id, err := uuid.Parse(c.value)
		if err != nil {
			return "", nil, fmt.Errorf("filter app takes an app id, not %q", c.value)
		}
		return "app_id = ?", []any{id}, nil
	case "env":
		return "environment = ?", []any{c.value}, nil
	case "status":
		ranges, err := parseStatusFilter(c.value)
		if err != nil {
			return "", nil, err
		}
		if len(ranges) == 0 {
			return "", nil, fmt.Errorf("filter status takes a code, class or range, not %q", c.value)
		}
		or := make([]string, 0, len(ranges))
		args := make([]any, 0, 2*len(ranges))
		for _, r := range ranges {
			or = append(or, "status_code BETWEEN ? AND ?")
			args = append(args, r.lo, r.hi)
		}
		return "(" + strings.Join(or, " OR ") + ")", args, nil
	case "payload":
		pat := likeContains(c.value)
		return "(request_payload ILIKE ? OR response_payload ILIKE ?)", []any{pat, pat}, nil
	case "sampled":
		switch strings.ToLower(c.value) {
		case "true":
			return "sampled = 1", nil, nil
		case "false":
			return "sampled = 0", nil, nil
		}
		return "", nil, fmt.Errorf("filter sampled takes true or false, not %q", c.value)
	}
	if col, ok := numberColumns[c.field]; ok {
		switch c.op {
		case "gt", "lt":
			n, err := bound(c.field, c.value)
			if err != nil {
				return "", nil, err
			}
			cmp := ">="
			if c.op == "lt" {
				cmp = "<="
			}
			return col + " " + cmp + " ?", []any{n}, nil
		default: // between
			loS, hiS, ok := strings.Cut(c.value, "-")
			if !ok {
				return "", nil, fmt.Errorf("filter %s:between takes a-b, not %q", c.field, c.value)
			}
			lo, err := bound(c.field, loS)
			if err != nil {
				return "", nil, err
			}
			hi, err := bound(c.field, hiS)
			if err != nil {
				return "", nil, err
			}
			if hi < lo {
				return "", nil, fmt.Errorf("filter %s:between %q is reversed", c.field, c.value)
			}
			return col + " BETWEEN ? AND ?", []any{lo, hi}, nil
		}
	}
	col := textColumns[c.field]
	if positive == "contains" {
		return col + " ILIKE ?", []any{likeContains(c.value)}, nil
	}
	return col + " = ?", []any{c.value}, nil
}

// conditionFilter appends the WHERE clauses of raw conditions to clauses.
// One field's eq values form one OR group, as do its contains values; each
// neq and ncontains value is a NOT clause of its own.
func conditionFilter(raw []string, clauses []string, args []any) ([]string, []any, error) {
	conds, err := parseConditions(raw)
	if err != nil {
		return nil, nil, err
	}
	type group struct {
		sql  []string
		args []any
	}
	groups := map[string]*group{}
	var order []string
	for _, c := range conds {
		sql, a, err := conditionClause(c)
		if err != nil {
			return nil, nil, huma.Error422UnprocessableEntity("invalid filter: " + err.Error())
		}
		switch c.op {
		case "eq", "contains":
			key := c.field + ":" + c.op
			g, ok := groups[key]
			if !ok {
				g = &group{}
				groups[key] = g
				order = append(order, key)
			}
			g.sql = append(g.sql, sql)
			g.args = append(g.args, a...)
		case "neq", "ncontains":
			clauses = append(clauses, "NOT ("+sql+")")
			args = append(args, a...)
		default:
			clauses = append(clauses, sql)
			args = append(args, a...)
		}
	}
	for _, key := range order {
		g := groups[key]
		if len(g.sql) == 1 {
			clauses = append(clauses, g.sql[0])
		} else {
			clauses = append(clauses, "("+strings.Join(g.sql, " OR ")+")")
		}
		args = append(args, g.args...)
	}
	return clauses, args, nil
}
