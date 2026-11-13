package query

import (
	"context"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/retention"
)

// RetentionPath is the path of a project's data retention. The project is
// {project}, its slug, as authz.Guard reads it.
const RetentionPath = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/retention"

// RetentionSignal is how long one kind of telemetry is kept.
type RetentionSignal struct {
	Key          string `json:"key" enum:"requests,logs,spans,rollups_1m,rollups_1h,deploys" doc:"Signal identifier; for a configurable signal also the retention.* config key."`
	Label        string `json:"label" doc:"Human name of the signal."`
	PeriodDays   int    `json:"period_days" doc:"Days the data is kept before ClickHouse deletes it, as the table TTL enforces it now."`
	Covers       string `json:"covers" doc:"What the signal holds and which screens read it."`
	Configurable bool   `json:"configurable" doc:"Whether the install may change the period (retention.<key> in the server config, applied by apilens migrate). Never per project."`
}

// Retention is the retention of every signal, in display order.
type Retention struct {
	Signals []RetentionSignal `json:"signals" doc:"One entry per signal, in display order."`
}

type retentionInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
}

type retentionOutput struct {
	Body Retention
}

// registerRetention mounts GET /api/v1/projects/{project}/retention, open to
// a session with view on the project.
func registerRetention(api huma.API, s *Service, guard *authz.Guard) {
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-project-retention",
		Method:      http.MethodGet,
		Path:        RetentionPath,
		Summary:     "How long each signal is kept",
		Description: "Lists, per signal (requests, logs, spans, per-minute and hourly metrics, deploys), the period ClickHouse keeps it, " +
			"what it covers and whether the install may change it. Retention is set per install, not per project: " +
			"self-hosted operators change retention.* and run apilens migrate. Open to a session that can view the project.",
		Tags:        []string{server.TagProjects},
		Security:    []map[string][]string{{authn.SchemeSession: {}}},
		Middlewares: huma.Middlewares{guard.RequireProject(api, authz.ProjectView)},
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable), s.retention)
}

func (s *Service) retention(ctx context.Context, _ *retentionInput) (*retentionOutput, error) {
	if _, ok := authz.TargetFromContext(ctx); !ok {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, retention.TablesQuery)
	if err != nil {
		return nil, internalError("retention", err)
	}
	defer func() { _ = rows.Close() }()
	days := map[string]int{}
	for rows.Next() {
		var name, stmt string
		if err := rows.Scan(&name, &stmt); err != nil {
			return nil, internalError("retention", err)
		}
		if d, ok := retention.ParseDays(stmt); ok {
			days[name] = d
		}
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("retention", err)
	}
	out := &retentionOutput{Body: Retention{Signals: make([]RetentionSignal, 0, len(retention.Signals))}}
	for _, sig := range retention.Signals {
		d, ok := days[sig.Table]
		if !ok {
			return nil, internalError("retention", fmt.Errorf("table %s has no TTL", sig.Table))
		}
		out.Body.Signals = append(out.Body.Signals, RetentionSignal{
			Key: sig.Key, Label: sig.Label, PeriodDays: d, Covers: sig.Covers, Configurable: sig.Configurable,
		})
	}
	return out, nil
}
