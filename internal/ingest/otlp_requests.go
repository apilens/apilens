package ingest

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"

	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/pipeline"
)

// OTLP server spans as requests. An app instrumented only with OpenTelemetry
// (a Java agent, the .NET or Go auto-instrumentation) sends no v1 request
// records, so without this its Traffic, Endpoints and Performance stay
// empty. Each HTTP server span (kind server with an HTTP method) also becomes
// a request row carrying the span's trace and span ids, so the request opens
// its own trace. Like exception logs, these rows derive from accepted spans
// and are not counted as records.
//
// OpenTelemetry records no bodies. The APILens agent extensions (see
// packages/otel-extension-vertx) put them on the server span as the payload
// attributes below; they become the request's payload and headers, masked by
// the project's privacy policy and capped like the SDKs' own, and are never
// stored as span attributes.

const (
	attrRequestBody     = "apilens.request.body"
	attrResponseBody    = "apilens.response.body"
	attrRequestHeaders  = "apilens.request.headers"
	attrResponseHeaders = "apilens.response.headers"
)

func isPayloadAttribute(key string) bool {
	switch key {
	case attrRequestBody, attrResponseBody, attrRequestHeaders, attrResponseHeaders:
		return true
	}
	return false
}

type spanPayload struct {
	requestBody, responseBody, requestHeaders, responseHeaders string
}

func otlpPayload(kvs []*commonpb.KeyValue) spanPayload {
	var p spanPayload
	for _, kv := range kvs {
		switch kv.GetKey() {
		case attrRequestBody:
			p.requestBody = anyString(kv.GetValue())
		case attrResponseBody:
			p.responseBody = anyString(kv.GetValue())
		case attrRequestHeaders:
			p.requestHeaders = anyString(kv.GetValue())
		case attrResponseHeaders:
			p.responseHeaders = anyString(kv.GetValue())
		}
	}
	return p
}

var (
	uuidSegment = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	hexSegment  = regexp.MustCompile(`^[0-9a-fA-F]{16,}$`)
	numSegment  = regexp.MustCompile(`^[0-9]+$`)
)

// serverRequest maps an accepted span; ok is false unless it is an HTTP
// server span.
func serverRequest(sp pipeline.SpanRow, pl spanPayload) (pipeline.RequestRow, bool) {
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
	consumer := bearerConsumer(pl.requestHeaders) // before redaction masks the header
	return pipeline.RequestRow{
		ProjectID:       sp.ProjectID,
		AppID:           sp.AppID,
		Environment:     sp.Environment,
		Timestamp:       sp.Timestamp,
		Method:          truncate(method, 16),
		Path:            short(path),
		RawPath:         truncate(raw, maxPayloadChars),
		StatusCode:      sp.StatusCode,
		ResponseTimeMs:  nonNegative(sp.DurationMs),
		RequestSize:     attrSize(attrs, "http.request.body.size", "http.request_content_length"),
		ResponseSize:    attrSize(attrs, "http.response.body.size", "http.response_content_length"),
		IPAddress:       truncate(strings.TrimSpace(firstNonEmpty(attrs["client.address"], attrs["http.client_ip"], attrs["network.peer.address"])), 64),
		UserAgent:       short(firstNonEmpty(attrs["user_agent.original"], attrs["http.user_agent"])),
		BaseURL:         short(baseURL(attrs)),
		RequestPayload:  pl.requestBody,
		ConsumerID:      consumer.id,
		ConsumerName:    consumer.name,
		ConsumerGroup:   consumer.group,
		ResponsePayload: pl.responseBody,
		RequestHeaders:  pl.requestHeaders,
		ResponseHeaders: pl.responseHeaders,
		TraceID:         sp.TraceID,
		SpanID:          sp.SpanID,
		Release:         sp.Release,
		Commit:          sp.Commit,
		Sampled:         true,
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

// redactRequestRow masks a derived request like redactRequest masks an SDK
// record; it reports whether anything was masked.
func redactRequestRow(r *privacy.Redactor, row *pipeline.RequestRow) bool {
	before := *row
	row.Path = r.RawPath(row.Path)
	row.RawPath = r.RawPath(row.RawPath)
	row.RequestHeaders = r.Headers(row.RequestHeaders)
	row.ResponseHeaders = r.Headers(row.ResponseHeaders)
	row.RequestPayload = r.Body(row.RequestPayload)
	row.ResponsePayload = r.Body(row.ResponsePayload)
	return row.Path != before.Path || row.RawPath != before.RawPath ||
		row.RequestHeaders != before.RequestHeaders || row.ResponseHeaders != before.ResponseHeaders ||
		row.RequestPayload != before.RequestPayload || row.ResponsePayload != before.ResponsePayload
}

// capRequestRow applies capRequests' caps; caps memoizes each app's payload cap.
func (e *Edge) capRequestRow(ctx context.Context, caps map[uuid.UUID]int, row *pipeline.RequestRow, t tally) {
	n, ok := caps[row.AppID]
	if !ok {
		n = e.payloadCap(ctx, row.AppID)
		caps[row.AppID] = n
	}
	c := t.app(row.AppID)
	e.capField(c, FieldRequestPayload, &row.RequestPayload, n)
	e.capField(c, FieldResponsePayload, &row.ResponsePayload, n)
	e.capField(c, FieldRequestHeaders, &row.RequestHeaders, maxHeaderBytes)
	e.capField(c, FieldResponseHeaders, &row.ResponseHeaders, maxHeaderBytes)
}

// Claims naming the caller of a request that carries a bearer JWT, most
// specific first. "sub" comes last: many issuers put a constant there.
var (
	consumerIDClaims    = []string{"user.id", "user_id", "uid", "id", "sub"}
	consumerNameClaims  = []string{"user.name", "preferred_username", "username", "name", "email"}
	consumerGroupClaims = []string{"tenant", "org", "organization", "group", "role"}
)

type consumerInfo struct{ id, name, group string }

// bearerConsumer reads the consumer from the claims of the bearer JWT in the
// request headers (a JSON object). The signature is not checked: this only
// attributes traffic, it authorizes nothing.
func bearerConsumer(headersJSON string) consumerInfo {
	if headersJSON == "" {
		return consumerInfo{}
	}
	var headers map[string]string
	if json.Unmarshal([]byte(headersJSON), &headers) != nil {
		return consumerInfo{}
	}
	var auth string
	for k, v := range headers {
		if strings.EqualFold(k, "authorization") {
			auth = strings.TrimSpace(v)
		}
	}
	scheme, token, ok := strings.Cut(auth, " ")
	if !ok || !strings.EqualFold(scheme, "bearer") {
		return consumerInfo{}
	}
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return consumerInfo{}
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return consumerInfo{}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // ids past 2^53 keep their digits
	var claims map[string]any
	if dec.Decode(&claims) != nil {
		return consumerInfo{}
	}
	c := consumerInfo{
		id:    claim(claims, consumerIDClaims),
		name:  claim(claims, consumerNameClaims),
		group: claim(claims, consumerGroupClaims),
	}
	if c.id == "" {
		c.id = c.name
	}
	return c
}

func claim(claims map[string]any, keys []string) string {
	for _, k := range keys {
		switch v := claims[k].(type) {
		case string:
			if v = strings.TrimSpace(v); v != "" {
				return truncate(v, 256)
			}
		case json.Number:
			return v.String()
		}
	}
	return ""
}
