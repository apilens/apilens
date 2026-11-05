package query

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Per-endpoint settings: expected status codes (left out of every error
// count and error rate the dashboard reports), a latency threshold and
// exclusion (the endpoint is hidden from the summary, timeseries, endpoint
// list and error list; its requests stay in Explore, /api/v1/requests).

// EndpointSettingsPath is the settings of one endpoint of an app.
const EndpointSettingsPath = server.APIPrefix + "/apps/{id}/endpoints/{method}/{path}/settings"

// Limits of the endpoint settings.
const (
	maxExpectedStatusCodes = 32
	maxLatencyThresholdMs  = 600_000
)

// EndpointSettingsStore is the control-plane subset the endpoint settings
// operations use; *db.Queries satisfies it. The Service's Catalog must
// implement it too, or the operations answer 503.
type EndpointSettingsStore interface {
	GetProjectApp(ctx context.Context, arg db.GetProjectAppParams) (db.GetProjectAppRow, error)
	GetSettingsApp(ctx context.Context, id uuid.UUID) (db.GetSettingsAppRow, error)
	GetEndpointSettings(ctx context.Context, arg db.GetEndpointSettingsParams) (db.EndpointSetting, error)
	UpsertEndpointSettings(ctx context.Context, arg db.UpsertEndpointSettingsParams) (db.EndpointSetting, error)
}

// endpointRulesStore lists the settings that change what the dashboard
// counts. A Catalog without it applies no settings.
type endpointRulesStore interface {
	ListProjectEndpointSettings(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectEndpointSettingsRow, error)
}

// EndpointSettings are the settings of one endpoint of an app.
type EndpointSettings struct {
	AppID               string     `json:"app_id" format:"uuid" doc:"The app's id."`
	Method              string     `json:"method" doc:"HTTP method, upper case."`
	Path                string     `json:"path" doc:"Route template."`
	ExpectedStatusCodes []int      `json:"expected_status_codes" doc:"Status codes that are expected for this endpoint, ascending: requests answered with them do not count as client or server errors in the summary, timeseries, endpoint list and error list."`
	LatencyThresholdMs  *int       `json:"latency_threshold_ms" required:"true" nullable:"true" doc:"Response time in milliseconds above which a request of this endpoint is slow; null means the project default."`
	Excluded            bool       `json:"excluded" doc:"Whether the endpoint is left out of the summary, timeseries, endpoint list and error list. Its requests stay in the request log."`
	UpdatedAt           *time.Time `json:"updated_at" required:"true" nullable:"true" doc:"When the settings were last saved; null if they never were (the defaults apply)."`
	UpdatedBy           *string    `json:"updated_by" required:"true" nullable:"true" format:"uuid" doc:"The user who last saved the settings; null if they never were saved or that user is gone."`
}

type endpointSettingsOutput struct {
	Body EndpointSettings
}

// EndpointRef names one endpoint of an app. Exported so Huma reads the
// fields of the types embedding it.
type EndpointRef struct {
	ID     string `path:"id" format:"uuid" doc:"The app's id."`
	Method string `path:"method" pattern:"^[A-Za-z]{1,16}$" doc:"HTTP method, e.g. GET (case-insensitive)."`
	Path   string `path:"path" minLength:"1" maxLength:"1024" doc:"Route template, URL-encoded as one path segment, e.g. %2Forders%2F%7Bid%7D for /orders/{id}."`
}

type getEndpointSettingsInput struct {
	ProjectInput
	EndpointRef
}

type putEndpointSettingsInput struct {
	EndpointRef
	Body struct {
		ExpectedStatusCodes []int `json:"expected_status_codes,omitempty" maxItems:"32" doc:"Status codes (100 to 599, at most 32) that are expected for this endpoint; duplicates are dropped. Omitted means none."`
		LatencyThresholdMs  *int  `json:"latency_threshold_ms,omitempty" minimum:"1" maximum:"600000" nullable:"true" doc:"Response time in milliseconds (1 to 600000) above which a request is slow; omitted or null means the project default."`
		Excluded            bool  `json:"excluded" doc:"Leave the endpoint out of the summary, timeseries, endpoint list and error list."`
	}
}

func registerEndpointSettings(api huma.API, s *Service, guard *authz.Guard) {
	how := "Settings are keyed by app, method and route template; an endpoint without saved settings has no expected status codes, no latency threshold and is not excluded. " +
		"An unknown app, or one in another project, answers 404."
	huma.Register(api, huma.Operation{
		OperationID: "get-endpoint-settings",
		Method:      http.MethodGet,
		Path:        EndpointSettingsPath,
		Summary:     "Get the settings of an endpoint",
		Description: "Expected status codes, latency threshold and exclusion of one endpoint of an app. Open to project viewers and the project's read key. " + how,
		Tags:        []string{"Dashboard"},
		Security:    security,
	}, s.getEndpointSettings)
	huma.Register(api, huma.Operation{
		OperationID: "put-endpoint-settings",
		Method:      http.MethodPut,
		Path:        EndpointSettingsPath,
		Summary:     "Replace the settings of an endpoint",
		Description: "Replaces the expected status codes, latency threshold and exclusion of one endpoint of an app. Needs a user session with `manage_capture` on the app's project " +
			"(project admins, organization owners and admins; 403 for other members). Dashboard reads apply the change on their next query. " + how,
		Tags:     []string{server.TagProjects}, // a session-only write, unlike the Dashboard reads
		Security: []map[string][]string{{authn.SchemeSession: {}}},
	}, func(ctx context.Context, in *putEndpointSettingsInput) (*endpointSettingsOutput, error) {
		var projects ProjectAuthorizer
		if guard != nil {
			projects = guard
		}
		return s.putEndpointSettings(ctx, projects, in)
	})
}

func (s *Service) settingsStore() (EndpointSettingsStore, error) {
	store, ok := s.catalog.(EndpointSettingsStore)
	if !ok {
		return nil, huma.Error503ServiceUnavailable("endpoint settings unavailable")
	}
	return store, nil
}

func (s *Service) getEndpointSettings(ctx context.Context, in *getEndpointSettingsInput) (*endpointSettingsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	store, err := s.settingsStore()
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("app not found")
	}
	app, err := store.GetProjectApp(ctx, db.GetProjectAppParams{ID: id, ProjectID: p.ProjectID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("app not found")
	}
	if err != nil {
		return nil, internalError("app lookup", err)
	}
	method := strings.ToUpper(in.Method)
	row, err := store.GetEndpointSettings(ctx, db.GetEndpointSettingsParams{AppID: app.ID, Method: method, Path: in.Path})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return &endpointSettingsOutput{Body: EndpointSettings{
			AppID: app.ID.String(), Method: method, Path: in.Path, ExpectedStatusCodes: []int{},
		}}, nil
	case err != nil:
		return nil, internalError("endpoint settings", err)
	}
	return &endpointSettingsOutput{Body: toEndpointSettings(row)}, nil
}

func (s *Service) putEndpointSettings(ctx context.Context, projects ProjectAuthorizer, in *putEndpointSettingsInput) (*endpointSettingsOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, huma.Error401Unauthorized("a user session is required")
	}
	store, err := s.settingsStore()
	if err != nil {
		return nil, err
	}
	codes, err := normalizeStatusCodes(in.Body.ExpectedStatusCodes)
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
	if err := authorizeManage(ctx, projects, p, app); err != nil {
		return nil, err
	}
	uid := p.UserID
	row, err := store.UpsertEndpointSettings(ctx, db.UpsertEndpointSettingsParams{
		AppID: app.ID, Method: strings.ToUpper(in.Method), Path: in.Path,
		ExpectedStatusCodes: codes, LatencyThresholdMs: threshold, Excluded: in.Body.Excluded, UpdatedBy: &uid,
	})
	if err != nil {
		return nil, internalError("save endpoint settings", err)
	}
	return &endpointSettingsOutput{Body: toEndpointSettings(row)}, nil
}

// authorizeManage checks that p may change the settings of app's project.
func authorizeManage(ctx context.Context, projects ProjectAuthorizer, p authn.Principal, app db.GetSettingsAppRow) error {
	if projects == nil {
		return huma.Error503ServiceUnavailable("authorization backend unavailable, retry later")
	}
	t, err := projects.AuthorizeProject(ctx, p, app.ProjectSlug, authz.ProjectManageCapture)
	switch {
	case err == nil && t.ProjectID == app.ProjectID:
		return nil
	case err == nil, errors.Is(err, authz.ErrNoResource):
		// The slug now names another project (the app's was deleted), or
		// the caller cannot view the project.
		return huma.Error404NotFound("app not found")
	case errors.Is(err, authz.ErrForbidden):
		return huma.Error403Forbidden("changing endpoint settings needs a project admin")
	case errors.Is(err, authz.ErrUnavailable):
		return huma.Error503ServiceUnavailable("authorization backend unavailable, retry later")
	default:
		return internalError("authorization", err)
	}
}

// normalizeStatusCodes validates, sorts and deduplicates expected codes.
func normalizeStatusCodes(in []int) ([]int32, error) {
	out := make([]int32, 0, len(in))
	for _, c := range in {
		if c < 100 || c > 599 {
			return nil, huma.Error422UnprocessableEntity(fmt.Sprintf("expected status code %d is not between 100 and 599", c))
		}
		out = append(out, int32(c))
	}
	slices.Sort(out)
	out = slices.Compact(out)
	if len(out) > maxExpectedStatusCodes {
		return nil, huma.Error422UnprocessableEntity("at most 32 expected status codes")
	}
	return out, nil
}

func toEndpointSettings(r db.EndpointSetting) EndpointSettings {
	out := EndpointSettings{
		AppID: r.AppID.String(), Method: r.Method, Path: r.Path, Excluded: r.Excluded,
		ExpectedStatusCodes: make([]int, 0, len(r.ExpectedStatusCodes)),
	}
	for _, c := range r.ExpectedStatusCodes {
		out.ExpectedStatusCodes = append(out.ExpectedStatusCodes, int(c))
	}
	if r.LatencyThresholdMs != nil {
		v := int(*r.LatencyThresholdMs)
		out.LatencyThresholdMs = &v
	}
	t := r.UpdatedAt.UTC()
	out.UpdatedAt = &t
	if r.UpdatedBy != nil {
		u := r.UpdatedBy.String()
		out.UpdatedBy = &u
	}
	return out
}

// ---------------------------------------------------------------- rules

// endpointKey names an endpoint of an app.
type endpointKey struct {
	app          uuid.UUID
	method, path string
}

// metricRules are the endpoint settings applied to a project's dashboard
// reads: excluded endpoints, and the expected error status codes of the
// others.
type metricRules struct {
	excluded []endpointKey
	expected []expectedRule
}

type expectedRule struct {
	endpointKey
	codes []int32 // 400..599 only: lower codes are never errors
}

func newMetricRules(rows []db.ListProjectEndpointSettingsRow) metricRules {
	var r metricRules
	for _, row := range rows {
		k := endpointKey{app: row.AppID, method: row.Method, path: row.Path}
		if row.Excluded {
			r.excluded = append(r.excluded, k)
			continue
		}
		var codes []int32
		for _, c := range row.ExpectedStatusCodes {
			if c >= 400 && c <= 599 {
				codes = append(codes, c)
			}
		}
		if len(codes) > 0 {
			r.expected = append(r.expected, expectedRule{endpointKey: k, codes: codes})
		}
	}
	return r
}

// endpointRules loads the rules of project. A Catalog that cannot list
// endpoint settings applies none.
func (s *Service) endpointRules(ctx context.Context, project uuid.UUID) (metricRules, error) {
	store, ok := s.catalog.(endpointRulesStore)
	if !ok {
		return metricRules{}, nil
	}
	rows, err := store.ListProjectEndpointSettings(ctx, project)
	if err != nil {
		return metricRules{}, internalError("endpoint settings", err)
	}
	return newMetricRules(rows), nil
}

// withoutExcluded appends the predicate leaving out excluded endpoints to a
// WHERE clause over a table with app_id, method and path columns.
func (r metricRules) withoutExcluded(where string, args []any) (string, []any) {
	if len(r.excluded) == 0 {
		return where, args
	}
	terms := make([]string, 0, len(r.excluded))
	for _, k := range r.excluded {
		terms = append(terms, "(app_id = ? AND method = ? AND path = ?)")
		args = append(args, k.app, k.method, k.path)
	}
	return where + " AND NOT (" + strings.Join(terms, " OR ") + ")", args
}

// expectedPredicate matches raw api_requests rows answered with an expected
// status code of their endpoint; "" when there are none. Status codes are
// validated integers, so they are inlined.
func (r metricRules) expectedPredicate() (string, []any) {
	if len(r.expected) == 0 {
		return "", nil
	}
	terms := make([]string, 0, len(r.expected))
	args := make([]any, 0, 3*len(r.expected))
	for _, e := range r.expected {
		codes := make([]string, len(e.codes))
		for i, c := range e.codes {
			codes[i] = fmt.Sprintf("%d", c)
		}
		terms = append(terms, "(app_id = ? AND method = ? AND path = ? AND status_code IN ("+strings.Join(codes, ", ")+"))")
		args = append(args, e.app, e.method, e.path)
	}
	return "(" + strings.Join(terms, " OR ") + ")", args
}

// errorCounts is a number of client (4xx) and server (5xx) errors.
type errorCounts struct{ client, server uint64 }

// subtract removes e from client and server, never going below zero.
func (e errorCounts) subtract(client, server *uint64) {
	*client -= min(*client, e.client)
	*server -= min(*server, e.server)
}

// expectedErrors counts, per key, the requests in [from, to) that a rollup
// read with where/args counted as errors but whose status code is expected
// for their endpoint. key is a ClickHouse String expression over
// api_requests (” for a single total). It answers an empty map when no
// endpoint has expected codes.
func (s *Service) expectedErrors(ctx context.Context, r metricRules, where string, args []any, from, to time.Time, key string) (map[string]errorCounts, error) {
	pred, pargs := r.expectedPredicate()
	out := map[string]errorCounts{}
	if pred == "" {
		return out, nil
	}
	// key comes from fixed expressions in this package, never from input.
	rows, err := s.ch.Query(ctx, `
		SELECT `+key+` AS k, countIf(status_code >= 400 AND status_code < 500), countIf(status_code >= 500)
		FROM api_requests WHERE `+where+` AND timestamp >= ? AND timestamp < ? AND `+pred+`
		GROUP BY k`, append(append(append([]any{}, args...), from, to), pargs...)...)
	if err != nil {
		return nil, internalError("expected errors", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			k string
			e errorCounts
		)
		if err := rows.Scan(&k, &e.client, &e.server); err != nil {
			return nil, internalError("expected errors", err)
		}
		out[k] = e
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("expected errors", err)
	}
	return out, nil
}
