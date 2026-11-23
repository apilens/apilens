package ingest

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/apilens/apilens/internal/pipeline"
)

// OTLP server spans as requests. An app instrumented only with OpenTelemetry
// (a Java agent, the .NET or Go auto-instrumentation) sends no v1 request
// records, so without this its Traffic, Endpoints and Performance stay
// empty. Each HTTP server span (kind server with an HTTP method) also becomes
// a request row carrying the span's trace and span ids, so the request opens
// its own trace. Like exception logs, these rows derive from accepted spans
// and are not counted as records.

var (
	uuidSegment = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	hexSegment  = regexp.MustCompile(`^[0-9a-fA-F]{16,}$`)
	numSegment  = regexp.MustCompile(`^[0-9]+$`)
)

// serverRequest maps an accepted span; ok is false unless it is an HTTP
// server span.
func serverRequest(sp pipeline.SpanRow) (pipeline.RequestRow, bool) {
	if sp.Kind != "server" {
		return pipeline.RequestRow{}, false
	}
	attrs := sp.Attributes
	method := strings.ToUpper(strings.TrimSpace(firstNonEmpty(attrs["http.request.method"], attrs["http.method"])))
	raw := cleanPath(firstNonEmpty(attrs["url.path"], attrs["http.target"]))
	path := requestPath(attrs["http.route"], raw)
	if method == "" || path == "" {
		return pipeline.RequestRow{}, false
	}
	return pipeline.RequestRow{
		ProjectID:      sp.ProjectID,
		AppID:          sp.AppID,
		Environment:    sp.Environment,
		Timestamp:      sp.Timestamp,
		Method:         truncate(method, 16),
		Path:           short(path),
		RawPath:        truncate(raw, maxPayloadChars),
		StatusCode:     sp.StatusCode,
		ResponseTimeMs: nonNegative(sp.DurationMs),
		RequestSize:    attrSize(attrs, "http.request.body.size", "http.request_content_length"),
		ResponseSize:   attrSize(attrs, "http.response.body.size", "http.response_content_length"),
		IPAddress:      truncate(strings.TrimSpace(firstNonEmpty(attrs["client.address"], attrs["http.client_ip"], attrs["network.peer.address"])), 64),
		UserAgent:      short(firstNonEmpty(attrs["user_agent.original"], attrs["http.user_agent"])),
		BaseURL:        short(baseURL(attrs)),
		TraceID:        sp.TraceID,
		SpanID:         sp.SpanID,
		Release:        sp.Release,
		Commit:         sp.Commit,
		Sampled:        true,
	}, true
}

// requestPath prefers the span's route template. A route that is only the
// mount point of a sub-router ("/api/v1" for "/api/v1/users/42") says too
// little, so then the raw path is used with its id-like segments templated.
func requestPath(route, raw string) string {
	route = cleanPath(route)
	switch {
	case route != "" && (raw == "" || !strings.HasPrefix(raw, strings.TrimSuffix(route, "/")+"/")):
		return route
	case raw != "":
		return templatePath(raw)
	}
	return ""
}

// cleanPath drops the query and fragment and collapses repeated slashes.
func cleanPath(p string) string {
	p = strings.TrimSpace(p)
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	if p == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(p))
	prev := byte(0)
	for i := 0; i < len(p); i++ {
		if p[i] == '/' && prev == '/' {
			continue
		}
		prev = p[i]
		b.WriteByte(p[i])
	}
	return b.String()
}

// templatePath replaces numbers, UUIDs and long hex ids with placeholders,
// so one endpoint does not split into a row per id.
func templatePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		switch {
		case uuidSegment.MatchString(s):
			segs[i] = "{uuid}"
		case numSegment.MatchString(s), hexSegment.MatchString(s):
			segs[i] = "{id}"
		}
	}
	return strings.Join(segs, "/")
}

func attrSize(attrs map[string]string, keys ...string) uint64 {
	for _, k := range keys {
		if n, err := strconv.ParseInt(attrs[k], 10, 64); err == nil {
			return sizeOf(n)
		}
	}
	return 0
}

func baseURL(attrs map[string]string) string {
	host := firstNonEmpty(attrs["server.address"], attrs["http.host"])
	if host == "" {
		return ""
	}
	if port := attrs["server.port"]; port != "" && !strings.Contains(host, ":") {
		host += ":" + port
	}
	if scheme := firstNonEmpty(attrs["url.scheme"], attrs["http.scheme"]); scheme != "" {
		return scheme + "://" + host
	}
	return host
}
