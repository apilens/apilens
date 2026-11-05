package ingest

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/privacy"
)

// PolicySource returns the compiled server-side privacy policy for records
// of an app; *privacy.Resolver satisfies it.
type PolicySource interface {
	Redactor(ctx context.Context, projectID, appID uuid.UUID) (*privacy.Redactor, error)
}

// WithPrivacy makes the edge apply the projects' and apps' privacy policies
// on top of the built-in defaults. Without it only the defaults apply.
func (e *Edge) WithPrivacy(src PolicySource) *Edge {
	e.privacy = src
	return e
}

// redactors looks up the redactor of every app in a batch once.
type redactors struct {
	e       *Edge
	project uuid.UUID
	byApp   map[uuid.UUID]*privacy.Redactor
}

func (e *Edge) redactors(projectID uuid.UUID) *redactors {
	return &redactors{e: e, project: projectID, byApp: map[uuid.UUID]*privacy.Redactor{}}
}

func (rs *redactors) get(ctx context.Context, appID uuid.UUID) (*privacy.Redactor, *apiError) {
	if rs.e.privacy == nil {
		return privacy.Default, nil
	}
	if r, ok := rs.byApp[appID]; ok {
		return r, nil
	}
	r, err := rs.e.privacy.Redactor(ctx, rs.project, appID)
	if err != nil {
		// Storing records without the project's policy could store what it
		// forbids: refuse, the SDK retries.
		rs.e.logger.Error("privacy policy unavailable", "error", err)
		return nil, errUnavailable("Privacy policy unavailable, retry later")
	}
	rs.byApp[appID] = r
	return r, nil
}

// redactRequest masks a request record in place: query parameters in
// raw_path (and path, should it carry a query), captured headers and JSON
// bodies. It reports whether anything was masked (the redactor returns
// unchanged values as is).
func redactRequest(r *privacy.Redactor, rec *requestRecord) bool {
	before := *rec
	rec.Path = r.RawPath(rec.Path)
	rec.RawPath = r.RawPath(rec.RawPath)
	rec.RequestHeaders = r.Headers(rec.RequestHeaders)
	rec.ResponseHeaders = r.Headers(rec.ResponseHeaders)
	rec.RequestPayload = r.Body(rec.RequestPayload)
	rec.ResponsePayload = r.Body(rec.ResponsePayload)
	return rec.Path != before.Path || rec.RawPath != before.RawPath ||
		rec.RequestHeaders != before.RequestHeaders || rec.ResponseHeaders != before.ResponseHeaders ||
		rec.RequestPayload != before.RequestPayload || rec.ResponsePayload != before.ResponsePayload
}

// redactLog masks a log record in place: key=value pairs in the message and
// the payload's JSON body fields. It reports whether anything was masked.
func redactLog(r *privacy.Redactor, rec *logRecord) bool {
	msg, payload := rec.Message, rec.Payload
	rec.Message = r.Text(rec.Message)
	rec.Payload = r.Body(rec.Payload)
	return rec.Message != msg || rec.Payload != payload
}

// redactRequests masks every record and counts the masked ones per app.
func (e *Edge) redactRequests(ctx context.Context, projectID uuid.UUID, apps map[string]uuid.UUID, recs []requestRecord, t tally) *apiError {
	rs := e.redactors(projectID)
	for i := range recs {
		appID := apps[strings.TrimSpace(recs[i].AppID)]
		r, aerr := rs.get(ctx, appID)
		if aerr != nil {
			return aerr
		}
		if redactRequest(r, &recs[i]) {
			e.masked.WithLabelValues("requests").Inc()
			t.app(appID).Masked++
		}
	}
	return nil
}

// redactLogs masks every record and counts the masked ones per app.
func (e *Edge) redactLogs(ctx context.Context, projectID uuid.UUID, apps map[string]uuid.UUID, recs []logRecord, t tally) *apiError {
	rs := e.redactors(projectID)
	for i := range recs {
		appID := apps[strings.TrimSpace(recs[i].AppID)]
		r, aerr := rs.get(ctx, appID)
		if aerr != nil {
			return aerr
		}
		if redactLog(r, &recs[i]) {
			e.masked.WithLabelValues("logs").Inc()
			t.app(appID).Masked++
		}
	}
	return nil
}
