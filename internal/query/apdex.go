package query

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Apdex (Application Performance Index) scores response times against a
// threshold T in milliseconds:
//
//	satisfied  response_time_ms <= T
//	tolerating T < response_time_ms <= 4T
//	frustrated response_time_ms > 4T
//
//	apdex = (satisfied + tolerating / 2) / requests
//
// so 1 means every request was satisfied and 0 that every one frustrated.
// The score only looks at response times; status codes do not change it.
// It is null when there are no requests. T of a request is, in order of
// precedence, the latency_threshold_ms of its endpoint's settings
// (app, method, route template), the app-wide latency_threshold_ms of its
// app, then defaultApdexThresholdMs. Apdex is counted over raw
// api_requests rows, because the rollups keep no exact distribution.

// defaultApdexThresholdMs is T when neither the endpoint nor the app sets one.
const defaultApdexThresholdMs = 500

// AppSettingsPath is the app-wide settings of an app.
const AppSettingsPath = server.APIPrefix + "/apps/{id}/settings"

// apdexStore lists the Apdex thresholds of a project. A Catalog without it
// applies the default threshold everywhere.
type apdexStore interface {
	ListProjectEndpointLatencyThresholds(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectEndpointLatencyThresholdsRow, error)
	ListProjectAppLatencyThresholds(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectAppLatencyThresholdsRow, error)
}

// AppSettingsStore is the control-plane subset the app settings operations
// use; *db.Queries satisfies it. A Catalog without it answers 503.
type AppSettingsStore interface {
	GetAppSettings(ctx context.Context, arg db.GetAppSettingsParams) (db.GetAppSettingsRow, error)
	GetSettingsApp(ctx context.Context, id uuid.UUID) (db.GetSettingsAppRow, error)
	UpdateAppLatencyThreshold(ctx context.Context, arg db.UpdateAppLatencyThresholdParams) (db.UpdateAppLatencyThresholdRow, error)
}

// apdexThresholds are the thresholds a project overrides.
type apdexThresholds struct {
	endpoints []endpointThreshold
	apps      []appThreshold
}

type endpointThreshold struct {
	endpointKey
	ms int32
}

type appThreshold struct {
	app uuid.UUID
	ms  int32
}

// apdexThresholds loads the thresholds of project.
func (s *Service) apdexThresholds(ctx context.Context, project uuid.UUID) (apdexThresholds, error) {
	store, ok := s.catalog.(apdexStore)
	if !ok {
		return apdexThresholds{}, nil
	}
	eps, err := store.ListProjectEndpointLatencyThresholds(ctx, project)
	if err != nil {
		return apdexThresholds{}, internalError("apdex thresholds", err)
	}
	apps, err := store.ListProjectAppLatencyThresholds(ctx, project)
	if err != nil {
		return apdexThresholds{}, internalError("apdex thresholds", err)
	}
	var t apdexThresholds
	for _, r := range eps {
		t.endpoints = append(t.endpoints, endpointThreshold{endpointKey{app: r.AppID, method: r.Method, path: r.Path}, r.LatencyThresholdMs})
	}
	for _, r := range apps {
		t.apps = append(t.apps, appThreshold{app: r.ID, ms: r.LatencyThresholdMs})
	}
	return t, nil
}

// expr is the ClickHouse expression of T for a raw api_requests row:
// endpoint thresholds first, then app thresholds, then the default.
// Thresholds are validated integers, so they are inlined; the keys are
// bound.
func (t apdexThresholds) expr() (string, []any) {
	if len(t.endpoints) == 0 && len(t.apps) == 0 {
		return fmt.Sprintf("%d", defaultApdexThresholdMs), nil
	}
	terms := make([]string, 0, 2*(len(t.endpoints)+len(t.apps))+1)
	args := make([]any, 0, 3*len(t.endpoints)+len(t.apps))
	for _, e := range t.endpoints {
		terms = append(terms, "app_id = ? AND method = ? AND path = ?", fmt.Sprintf("%d", e.ms))
		args = append(args, e.app, e.method, e.path)
	}
	for _, a := range t.apps {
		terms = append(terms, "app_id = ?", fmt.Sprintf("%d", a.ms))
		args = append(args, a.app)
	}
	terms = append(terms, fmt.Sprintf("%d", defaultApdexThresholdMs))
	return "multiIf(" + strings.Join(terms, ", ") + ")", args
}

// apdexCounts are the requests of an Apdex score by outcome.
type apdexCounts struct {
	requests, satisfied, tolerating uint64
}

// score is the Apdex of c rounded to two decimals; nil without requests.
func (c apdexCounts) score() *float64 {
	if c.requests == 0 {
		return nil
	}
	v := round2((float64(c.satisfied) + float64(c.tolerating)/2) / float64(c.requests))
	return &v
}

// apdex counts, per key, the raw api_requests rows matching where/args
// (which must bound the time range) by Apdex outcome. key is a ClickHouse
// String expression over api_requests (” for a single total) from fixed
// expressions in this package, never from input.
func (s *Service) apdex(ctx context.Context, t apdexThresholds, where string, args []any, key string) (map[string]apdexCounts, error) {
	expr, targs := t.expr()
	rows, err := s.ch.Query(ctx, `
		WITH `+expr+` AS apdex_t
		SELECT `+key+` AS k, count(), countIf(response_time_ms <= apdex_t),
		       countIf(response_time_ms > apdex_t AND response_time_ms <= 4 * apdex_t)
		FROM api_requests WHERE `+where+`
		GROUP BY k`, append(append([]any{}, targs...), args...)...)
	if err != nil {
		return nil, internalError("apdex", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]apdexCounts{}
	for rows.Next() {
		var (
			k string
			c apdexCounts
		)
		if err := rows.Scan(&k, &c.requests, &c.satisfied, &c.tolerating); err != nil {
			return nil, internalError("apdex", err)
		}
		out[k] = c
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("apdex", err)
	}
	return out, nil
}

// ---------------------------------------------------------------- app settings

// AppSettings are the app-wide settings of an app.
type AppSettings struct {
	AppID              string `json:"app_id" format:"uuid" doc:"The app's id."`
	LatencyThresholdMs *int   `json:"latency_threshold_ms" required:"true" nullable:"true" doc:"Apdex threshold T in milliseconds for the app's endpoints that set none of their own; null means the default of 500 ms."`
	ApdexThresholdMs   int    `json:"apdex_threshold_ms" doc:"The threshold that applies to the app's endpoints without their own: latency_threshold_ms, or 500."`
}

type appSettingsOutput struct {
	Body AppSettings
}

type getAppSettingsInput struct {
	ProjectInput
	ID string `path:"id" format:"uuid" doc:"The app's id."`
}

type putAppSettingsInput struct {
	ID   string `path:"id" format:"uuid" doc:"The app's id."`
	Body struct {
		LatencyThresholdMs *int `json:"latency_threshold_ms,omitempty" minimum:"1" maximum:"600000" nullable:"true" doc:"Apdex threshold T in milliseconds (1 to 600000); omitted or null means the default of 500 ms."`
	}
}

func registerAppSettings(api huma.API, s *Service, guard *authz.Guard) {
	how := "The app-wide latency threshold is the Apdex threshold T of the app's endpoints whose settings set none (endpoint > app > 500 ms). " +
		"An unknown app, or one in another project, answers 404."
	huma.Register(api, huma.Operation{
		OperationID: "get-app-settings",
		Method:      http.MethodGet,
		Path:        AppSettingsPath,
		Summary:     "Get the settings of an app",
		Description: "The app-wide latency (Apdex) threshold. Open to project viewers and the project's read key. " + how,
		Tags:        []string{"Dashboard"},
		Security:    security,
	}, s.getAppSettings)
	huma.Register(api, huma.Operation{
		OperationID: "put-app-settings",
		Method:      http.MethodPut,
		Path:        AppSettingsPath,
		Summary:     "Replace the settings of an app",
		Description: "Replaces the app-wide latency (Apdex) threshold. Needs a user session with `manage_capture` on the app's project " +
			"(project admins, organization owners and admins; 403 for other members). " + how,
		Tags:     []string{server.TagProjects},
		Security: []map[string][]string{{authn.SchemeSession: {}}},
	}, func(ctx context.Context, in *putAppSettingsInput) (*appSettingsOutput, error) {
		var projects ProjectAuthorizer
		if guard != nil {
			projects = guard
		}
		return s.putAppSettings(ctx, projects, in)
	})
}

func (s *Service) appSettingsStore() (AppSettingsStore, error) {
	store, ok := s.catalog.(AppSettingsStore)
	if !ok {
		return nil, huma.Error503ServiceUnavailable("app settings unavailable")
	}
	return store, nil
}

func (s *Service) getAppSettings(ctx context.Context, in *getAppSettingsInput) (*appSettingsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	store, err := s.appSettingsStore()
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("app not found")
	}
	row, err := store.GetAppSettings(ctx, db.GetAppSettingsParams{ID: id, ProjectID: p.ProjectID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("app not found")
	}
	if err != nil {
		return nil, internalError("app settings", err)
	}
	return &appSettingsOutput{Body: toAppSettings(row.ID, row.LatencyThresholdMs)}, nil
}

func (s *Service) putAppSettings(ctx context.Context, projects ProjectAuthorizer, in *putAppSettingsInput) (*appSettingsOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, huma.Error401Unauthorized("a user session is required")
	}
	store, err := s.appSettingsStore()
	if err != nil {
		return nil, err
	}
	var threshold *int32
	if t := in.Body.LatencyThresholdMs; t != nil {
		if *t < 1 || *t > maxLatencyThresholdMs {
			return nil, huma.Error422UnprocessableEntity("latency_threshold_ms must be between 1 and 600000")
		}
		v := int32(*t)
		threshold = &v
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("app not found")
	}
	app, err := store.GetSettingsApp(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("app not found")
	}
	if err != nil {
		return nil, internalError("app lookup", err)
	}
	target, err := authorizeManage(ctx, projects, p, app)
	if err != nil {
		return nil, err
	}
	var row db.UpdateAppLatencyThresholdRow
	if err := audited(ctx, s, target, store, func(q *db.Queries) AppSettingsStore { return q }, func(store AppSettingsStore) (*audit.Event, error) {
		cur, err := store.GetAppSettings(ctx, db.GetAppSettingsParams{ID: app.ID, ProjectID: app.ProjectID})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, huma.Error404NotFound("app not found")
		}
		if err != nil {
			return nil, internalError("app settings", err)
		}
		row, err = store.UpdateAppLatencyThreshold(ctx, db.UpdateAppLatencyThresholdParams{ID: app.ID, LatencyThresholdMs: threshold})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, huma.Error404NotFound("app not found")
		}
		if err != nil {
			return nil, internalError("save app settings", err)
		}
		changes := audit.Diff(map[string]any{"latency_threshold_ms": cur.LatencyThresholdMs}, map[string]any{"latency_threshold_ms": row.LatencyThresholdMs})
		if changes == nil {
			return nil, nil
		}
		return &audit.Event{Kind: audit.AppSettingsUpdated, Target: settingsAppTarget(app.ID, app.Slug), Changes: changes}, nil
	}); err != nil {
		return nil, err
	}
	return &appSettingsOutput{Body: toAppSettings(row.ID, row.LatencyThresholdMs)}, nil
}

func toAppSettings(id uuid.UUID, ms *int32) AppSettings {
	out := AppSettings{AppID: id.String(), ApdexThresholdMs: defaultApdexThresholdMs}
	if ms != nil {
		v := int(*ms)
		out.LatencyThresholdMs, out.ApdexThresholdMs = &v, v
	}
	return out
}
