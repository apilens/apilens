package query

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// IngestStatusPath is the path of a project's ingest status. The project is
// {project}, its slug, as authz.Guard reads it.
const IngestStatusPath = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/ingest-status"

// IngestStatus says whether a project has received traffic yet.
type IngestStatus struct {
	Received bool       `json:"received" doc:"Whether any request was ever stored for the project (within retention)."`
	FirstAt  *time.Time `json:"first_at" doc:"Timestamp of the oldest stored request; null when none."`
	LastAt   *time.Time `json:"last_at" doc:"Timestamp of the newest stored request; null when none."`
	Count1h  uint64     `json:"count_1h" doc:"Requests stored with a timestamp in the last hour."`
}

type ingestStatusInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
}

type ingestStatusOutput struct {
	Body IngestStatus
}

// registerIngestStatus mounts GET /api/v1/projects/{project}/ingest-status,
// open to a user session with view on the project or to the project's read
// key; guard decides both.
func registerIngestStatus(api huma.API, s *Service, guard *authz.Guard) {
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-ingest-status",
		Method:      http.MethodGet,
		Path:        IngestStatusPath,
		Summary:     "Whether a project has received its first request",
		Description: "Answers whether any request has been stored for the project, when the first and last arrived and how many arrived in the last hour. " +
			"The onboarding 'Waiting for data' screen polls it. Open to a session that can view the project or to the project's read key.",
		Tags:        []string{server.TagProjects},
		Security:    []map[string][]string{{authn.SchemeSession: {}}, {SchemeReadKey: {}}},
		Middlewares: huma.Middlewares{guard.RequireProject(api, authz.ProjectView)},
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable), s.ingestStatus)
}

func (s *Service) ingestStatus(ctx context.Context, _ *ingestStatusInput) (*ingestStatusOutput, error) {
	t, ok := authz.TargetFromContext(ctx)
	if !ok {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	where, args := tenantFilter(t.ProjectID, "")
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	var (
		count, count1h uint64
		first, last    time.Time
	)
	err := s.ch.QueryRow(qctx, `SELECT count(), min(timestamp), max(timestamp), countIf(timestamp >= ?)
		FROM api_requests WHERE `+where,
		append([]any{s.now().UTC().Add(-time.Hour)}, args...)...).Scan(&count, &first, &last, &count1h)
	if err != nil {
		return nil, internalError("ingest status", err)
	}
	out := &ingestStatusOutput{Body: IngestStatus{Received: count > 0, Count1h: count1h}}
	if count > 0 {
		first, last = first.UTC(), last.UTC()
		out.Body.FirstAt, out.Body.LastAt = &first, &last
	}
	return out, nil
}
