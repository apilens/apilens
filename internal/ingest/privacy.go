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
// bodies.
func redactRequest(r *privacy.Redactor, rec *requestRecord) {
	rec.Path = r.RawPath(rec.Path)
	rec.RawPath = r.RawPath(rec.RawPath)
	rec.RequestHeaders = r.Headers(rec.RequestHeaders)
	rec.ResponseHeaders = r.Headers(rec.ResponseHeaders)
	rec.RequestPayload = r.Body(rec.RequestPayload)
	rec.ResponsePayload = r.Body(rec.ResponsePayload)
}

// redactLog masks a log record in place: key=value pairs in the message and
// the payload's JSON body fields.
func redactLog(r *privacy.Redactor, rec *logRecord) {
	rec.Message = r.Text(rec.Message)
	rec.Payload = r.Body(rec.Payload)
}

func (e *Edge) redactRequests(ctx context.Context, projectID uuid.UUID, apps map[string]uuid.UUID, recs []requestRecord) *apiError {
	rs := e.redactors(projectID)
	for i := range recs {
		r, aerr := rs.get(ctx, apps[strings.TrimSpace(recs[i].AppID)])
		if aerr != nil {
			return aerr
		}
		redactRequest(r, &recs[i])
	}
	return nil
}

func (e *Edge) redactLogs(ctx context.Context, projectID uuid.UUID, apps map[string]uuid.UUID, recs []logRecord) *apiError {
	rs := e.redactors(projectID)
	for i := range recs {
		r, aerr := rs.get(ctx, apps[strings.TrimSpace(recs[i].AppID)])
		if aerr != nil {
			return aerr
		}
		redactLog(r, &recs[i])
	}
	return nil
}
