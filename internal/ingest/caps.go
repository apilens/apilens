package ingest

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/capture"
)

// Server-side caps on the captured parts of a request record. They hold
// whatever the SDK sent: an old or misconfigured SDK cannot store more.
const (
	// defaultMaxPayloadBytes caps request_payload and response_payload of an
	// app whose capture policy sets no max_payload_bytes.
	defaultMaxPayloadBytes = 64 << 10
	// maxHeaderBytes caps request_headers and response_headers.
	maxHeaderBytes = 8 << 10
	// truncatedMarker ends every value the edge cut.
	truncatedMarker = "…[truncated]"
)

// Truncated fields, the `field` label of apilens_ingest_truncated_total.
const (
	FieldRequestPayload  = "request_payload"
	FieldResponsePayload = "response_payload"
	FieldRequestHeaders  = "request_headers"
	FieldResponseHeaders = "response_headers"
)

var truncatedFields = []string{FieldRequestPayload, FieldResponsePayload, FieldRequestHeaders, FieldResponseHeaders}

// CaptureSource returns the capture policy of an app; *capture.Resolver
// satisfies it.
type CaptureSource interface {
	Policy(ctx context.Context, appID uuid.UUID) (capture.Policy, error)
}

// WithCapture makes the edge cap payloads at each app's max_payload_bytes.
// Without it every app gets the default cap.
func (e *Edge) WithCapture(src CaptureSource) *Edge {
	e.capture = src
	return e
}

// payloadCap returns the payload cap of an app. A policy that cannot be read
// falls back to the default: caps bound storage, they are no privacy
// boundary, so a Postgres outage must not drop telemetry.
func (e *Edge) payloadCap(ctx context.Context, appID uuid.UUID) int {
	if e.capture == nil {
		return defaultMaxPayloadBytes
	}
	p, err := e.capture.Policy(ctx, appID)
	if err != nil {
		e.logger.Warn("capture policy unavailable; using the default payload cap", "app_id", appID, "error", err)
		return defaultMaxPayloadBytes
	}
	if p.MaxPayloadBytes == nil || *p.MaxPayloadBytes <= 0 {
		return defaultMaxPayloadBytes
	}
	return *p.MaxPayloadBytes
}

// capRequests truncates the payloads and headers of every record in place
// and counts each cut, per field and per app. It runs after redaction, so
// masking sees whole values.
func (e *Edge) capRequests(ctx context.Context, apps map[string]uuid.UUID, recs []requestRecord, t tally) {
	caps := map[uuid.UUID]int{}
	for i := range recs {
		rec := &recs[i]
		appID := apps[strings.TrimSpace(rec.AppID)]
		n, ok := caps[appID]
		if !ok {
			n = e.payloadCap(ctx, appID)
			caps[appID] = n
		}
		c := t.app(appID)
		e.capField(c, FieldRequestPayload, &rec.RequestPayload, n)
		e.capField(c, FieldResponsePayload, &rec.ResponsePayload, n)
		e.capField(c, FieldRequestHeaders, &rec.RequestHeaders, maxHeaderBytes)
		e.capField(c, FieldResponseHeaders, &rec.ResponseHeaders, maxHeaderBytes)
	}
}

func (e *Edge) capField(c *Counts, field string, s *string, n int) {
	var cut bool
	if *s, cut = capBytes(*s, n); cut {
		e.truncated.WithLabelValues(field).Inc()
		c.Truncated++
	}
}

// capBytes keeps the first n bytes of s, backing off to a UTF-8 boundary,
// and appends truncatedMarker when it cut anything. Invalid UTF-8 is
// replaced first (ClickHouse String accepts bytes, the dashboard expects
// text).
func capBytes(s string, n int) (string, bool) {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	if len(s) <= n {
		return s, false
	}
	cut := max(n, 0)
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + truncatedMarker, true
}
