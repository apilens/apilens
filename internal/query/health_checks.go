package query

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/alerts"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Health checks: a project's active HTTP checks of its apps' environments
// (internal/alerts: the alerts.health_checks job sends GET to each enabled
// URL every minute, 5 s timeout, one retry) and the events their failures
// open, each with the failed request's details. Readers and writers are
// the alert operations': everyone who can view the project reads them,
// manage_alerts writes them.

// The health check operations' paths.
const (
	HealthChecksPath     = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/alerts/health-checks"
	HealthCheckPath      = HealthChecksPath + "/{id}"
	HealthCheckEventPath = HealthCheckPath + "/events"
)

// WithHealthCheckPrivateNetworks lets health check URLs point to loopback,
// private and link-local addresses (alerts.health_checks_allow_private);
// by default they are refused.
func (s *Service) WithHealthCheckPrivateNetworks(allow bool) *Service {
	s.healthChecksPrivate = allow
	return s
}

// ---------------------------------------------------------------- types

// HealthCheckProbe is what one probe of a check saw.
type HealthCheckProbe struct {
	OK             bool      `json:"ok" doc:"Whether the last attempt answered expected_status."`
	StatusCode     int       `json:"status_code" doc:"The last attempt's response status; 0 when no response arrived."`
	ExpectedStatus int       `json:"expected_status"`
	LatencyMS      float64   `json:"latency_ms" doc:"The last attempt's time to the response, or to the failure, in milliseconds."`
	Error          string    `json:"error,omitempty" doc:"Why the last attempt failed: a failure class such as timeout, connection refused, DNS lookup failed, address not allowed (not a public address) or unexpected status 503. Omitted when it passed."`
	BodySnippet    string    `json:"body_snippet,omitempty" doc:"The start of a failed response's body, masked by the privacy policy, at most 1024 bytes. Omitted when the probe passed or the body was empty or not text."`
	BodyTruncated  bool      `json:"body_truncated,omitempty" doc:"Whether the body was longer than body_snippet."`
	Attempts       int       `json:"attempts" doc:"Attempts made: 1, or 2 with the retry."`
	CheckedAt      time.Time `json:"checked_at" doc:"When the probe started."`
}

// HealthCheck is an active HTTP check of one app environment.
type HealthCheck struct {
	ID             string            `json:"id" format:"uuid"`
	AppID          string            `json:"app_id" format:"uuid"`
	Environment    string            `json:"environment"`
	URL            string            `json:"url"`
	ExpectedStatus int32             `json:"expected_status"`
	Enabled        bool              `json:"enabled"`
	Status         string            `json:"status" enum:"up,down" doc:"down from a probe that failed its retry too until one passes."`
	StatusSince    time.Time         `json:"status_since"`
	CheckedAt      *time.Time        `json:"checked_at" required:"true" nullable:"true" doc:"The latest probe; null before the first (and after the URL or expected status changed)."`
	LastResult     *HealthCheckProbe `json:"last_result,omitempty" doc:"What the latest probe saw; omitted before the first."`
	CreatedBy      *string           `json:"created_by" required:"true" nullable:"true" format:"uuid"`
	CreatedAt      time.Time         `json:"created_at"`
	UpdatedAt      time.Time         `json:"updated_at"`
}

// HealthCheckEvent is one failure of a check, from the probe that failed
// to the one that passed again.
type HealthCheckEvent struct {
	ID         string           `json:"id" format:"uuid"`
	State      string           `json:"state" enum:"triggered,resolved"`
	StartedAt  time.Time        `json:"started_at"`
	EndedAt    *time.Time       `json:"ended_at" required:"true" nullable:"true"`
	NotifiedAt *time.Time       `json:"notified_at" required:"true" nullable:"true" doc:"When the first notification went out; null until then."`
	Failure    HealthCheckProbe `json:"failure" doc:"The failed request that opened the event."`
}

type healthCheckBody struct {
	Environment    string `json:"environment" minLength:"1" maxLength:"64" doc:"The environment the URL serves."`
	URL            string `json:"url" minLength:"1" maxLength:"2048" doc:"The URL to send GET to: http or https, no credentials or fragment, a public address unless the install allows private networks."`
	ExpectedStatus int32  `json:"expected_status,omitempty" minimum:"100" maximum:"599" doc:"The status a healthy response has; omitted means 200. Redirects are not followed."`
	Enabled        *bool  `json:"enabled,omitempty" required:"false" doc:"Whether the check runs; omitted means true."`
}

type createHealthCheckInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	Body    struct {
		AppID string `json:"app_id" format:"uuid" doc:"The app the URL belongs to; it never changes."`
		healthCheckBody
	}
}

type updateHealthCheckInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid"`
	Body    healthCheckBody
}

type healthCheckEventsInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid"`
	Limit   int32  `query:"limit" minimum:"1" maximum:"100" default:"20"`
}

type healthCheckOutput struct{ Body HealthCheck }

type healthChecksOutput struct {
	Body struct {
		HealthChecks []HealthCheck `json:"health_checks" doc:"The project's checks by app, environment and URL; checks of deleted apps are left out."`
	}
}

type healthCheckEventsOutput struct {
	Body struct {
		Events []HealthCheckEvent `json:"events" doc:"Newest first."`
	}
}

// ---------------------------------------------------------------- register

func registerHealthChecks(api huma.API, s *Service, guard *authz.Guard) {
	view := huma.Middlewares{guard.RequireProject(api, authz.ProjectView)}
	manage := huma.Middlewares{guard.RequireProject(api, authz.ProjectManageAlerts)}
	session := []map[string][]string{{authn.SchemeSession: {}}}
	readers := []map[string][]string{{authn.SchemeSession: {}}, {SchemeReadKey: {}}}
	guarded := []identity.ErrCode{identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable}
	writeGuarded := append([]identity.ErrCode{identity.CodeForbidden}, guarded...)
	readable := " Open to a session that can view the project or to the project's read key."
	admins := " Needs a user session with manage_alerts on the project (project admins, organization owners and admins); 403 for other members."

	op := func(id, method, path, summary, desc string, write bool, status int) huma.Operation {
		o := huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary,
			Tags: []string{server.TagProjects}, DefaultStatus: status,
			Description: desc + readable, Security: readers, Middlewares: view,
		}
		if !write {
			return identity.Operation(api, o, guarded...)
		}
		o.Description, o.Security, o.Middlewares = desc+admins, session, manage
		return identity.Operation(api, o, writeGuarded...)
	}

	huma.Register(api, op("list-health-checks", http.MethodGet, HealthChecksPath, "List the health checks of a project",
		"The project's active HTTP health checks, each with its status and latest probe.", false, 0), s.listHealthChecks)
	huma.Register(api, op("create-health-check", http.MethodPost, HealthChecksPath, "Create a health check",
		"Creates an active HTTP check: every minute APILens sends GET to the URL (5 s timeout, one retry) and opens an event with the failed request when it does not answer expected_status. "+
			"A URL that is not http(s), carries credentials or points to a non-public address answers 422, as does an app that is not the project's.",
		true, http.StatusCreated), s.createHealthCheck)
	huma.Register(api, op("get-health-check", http.MethodGet, HealthCheckPath, "Get a health check",
		"One check with its status and latest probe.", false, 0), s.getHealthCheck)
	huma.Register(api, op("update-health-check", http.MethodPut, HealthCheckPath, "Replace a health check",
		"Replaces every editable field of a check; its app never changes. A new URL or expected status clears the latest probe.", true, 0), s.updateHealthCheck)
	huma.Register(api, op("delete-health-check", http.MethodDelete, HealthCheckPath, "Delete a health check",
		"Deletes a check and its events.", true, http.StatusNoContent), s.deleteHealthCheck)
	huma.Register(api, op("list-health-check-events", http.MethodGet, HealthCheckEventPath, "List the events of a health check",
		"The check's failures, newest first, each with the failed request: status, latency, error and the start of the response body (masked, at most 1 KB).",
		false, 0), s.listHealthCheckEvents)
}

// ---------------------------------------------------------------- handlers

func (s *Service) listHealthChecks(ctx context.Context, _ *projectPathInput) (*healthChecksOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := q.ListHealthChecks(ctx, project)
	if err != nil {
		return nil, internalError("list health checks", err)
	}
	out := &healthChecksOutput{}
	out.Body.HealthChecks = make([]HealthCheck, 0, len(rows))
	for _, h := range rows {
		out.Body.HealthChecks = append(out.Body.HealthChecks, toHealthCheck(h))
	}
	return out, nil
}

func (s *Service) getHealthCheck(ctx context.Context, in *alertIDInput) (*healthCheckOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	h, err := s.loadHealthCheck(ctx, q, project, in.ID)
	if err != nil {
		return nil, err
	}
	return &healthCheckOutput{Body: toHealthCheck(h)}, nil
}

func (s *Service) createHealthCheck(ctx context.Context, in *createHealthCheckInput) (*healthCheckOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	user, err := alertUser(ctx)
	if err != nil {
		return nil, err
	}
	appID, err := uuid.Parse(in.Body.AppID)
	if err != nil {
		return nil, huma.Error422UnprocessableEntity("app_id is not an app of the project")
	}
	if err := s.checkRuleApp(ctx, project, appID); err != nil {
		return nil, err
	}
	v, err := s.checkHealthCheckBody(in.Body.healthCheckBody)
	if err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, internalError("health check id", err)
	}
	var h db.HealthCheck
	if err := audited(ctx, s, alertTarget(ctx), q, queries, func(q *db.Queries) (*audit.Event, error) {
		h, err = q.CreateHealthCheck(ctx, db.CreateHealthCheckParams{
			ID: id, ProjectID: project, AppID: appID, Environment: v.environment, Url: v.url,
			ExpectedStatus: v.expected, Enabled: v.enabled, CreatedBy: user,
		})
		if err != nil {
			return nil, internalError("create health check", err)
		}
		return &audit.Event{Kind: audit.HealthCheckCreated, Target: healthCheckTarget(h), Changes: audit.Diff(nil, healthCheckValues(h))}, nil
	}); err != nil {
		return nil, err
	}
	return &healthCheckOutput{Body: toHealthCheck(h)}, nil
}

func (s *Service) updateHealthCheck(ctx context.Context, in *updateHealthCheckInput) (*healthCheckOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := alertUser(ctx); err != nil {
		return nil, err
	}
	cur, err := s.loadHealthCheck(ctx, q, project, in.ID)
	if err != nil {
		return nil, err
	}
	v, err := s.checkHealthCheckBody(in.Body)
	if err != nil {
		return nil, err
	}
	h, err := q.UpdateHealthCheck(ctx, db.UpdateHealthCheckParams{
		ID: cur.ID, ProjectID: project, Environment: v.environment, Url: v.url, ExpectedStatus: v.expected, Enabled: v.enabled,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("health check not found")
	}
	if err != nil {
		return nil, internalError("update health check", err)
	}
	return &healthCheckOutput{Body: toHealthCheck(h)}, nil
}

func (s *Service) deleteHealthCheck(ctx context.Context, in *alertIDInput) (*struct{}, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := alertUser(ctx); err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("health check not found")
	}
	return nil, audited(ctx, s, alertTarget(ctx), q, queries, func(q *db.Queries) (*audit.Event, error) {
		cur, err := q.GetHealthCheck(ctx, db.GetHealthCheckParams{ProjectID: project, ID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, huma.Error404NotFound("health check not found")
		}
		if err != nil {
			return nil, internalError("health check", err)
		}
		n, err := q.DeleteHealthCheck(ctx, db.DeleteHealthCheckParams{ProjectID: project, ID: id})
		if err != nil {
			return nil, internalError("delete health check", err)
		}
		if n == 0 {
			return nil, huma.Error404NotFound("health check not found")
		}
		return &audit.Event{Kind: audit.HealthCheckDeleted, Target: healthCheckTarget(cur), Changes: audit.Diff(healthCheckValues(cur), nil)}, nil
	})
}

func (s *Service) listHealthCheckEvents(ctx context.Context, in *healthCheckEventsInput) (*healthCheckEventsOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	h, err := s.loadHealthCheck(ctx, q, project, in.ID)
	if err != nil {
		return nil, err
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	rows, err := q.ListHealthCheckEvents(ctx, db.ListHealthCheckEventsParams{HealthCheckID: h.ID, Lim: limit})
	if err != nil {
		return nil, internalError("list health check events", err)
	}
	out := &healthCheckEventsOutput{}
	out.Body.Events = make([]HealthCheckEvent, 0, len(rows))
	for _, e := range rows {
		ev := HealthCheckEvent{
			ID: e.ID.String(), State: e.State, StartedAt: e.StartedAt.UTC(), EndedAt: utcPtr(e.EndedAt), NotifiedAt: utcPtr(e.NotifiedAt),
		}
		if p := decodeProbe(e.Details); p != nil {
			ev.Failure = *p
		}
		out.Body.Events = append(out.Body.Events, ev)
	}
	return out, nil
}

// loadHealthCheck reads one check of the project; checks of deleted apps
// are not found, as in the list.
func (s *Service) loadHealthCheck(ctx context.Context, q *db.Queries, project uuid.UUID, rawID string) (db.HealthCheck, error) {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return db.HealthCheck{}, huma.Error404NotFound("health check not found")
	}
	h, err := q.GetHealthCheck(ctx, db.GetHealthCheckParams{ProjectID: project, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.HealthCheck{}, huma.Error404NotFound("health check not found")
	}
	if err != nil {
		return db.HealthCheck{}, internalError("health check", err)
	}
	if err := s.checkRuleApp(ctx, project, h.AppID); err != nil {
		return db.HealthCheck{}, huma.Error404NotFound("health check not found")
	}
	return h, nil
}

// validHealthCheck is a checked body, ready for the store.
type validHealthCheck struct {
	environment, url string
	expected         int32
	enabled          bool
}

// checkHealthCheckBody checks a body beyond its schema: the environment
// and the URL (alerts.ValidateHealthCheckURL, the SSRF guard's first line).
func (s *Service) checkHealthCheckBody(b healthCheckBody) (validHealthCheck, error) {
	bad := huma.Error422UnprocessableEntity
	v := validHealthCheck{environment: strings.TrimSpace(b.Environment), expected: b.ExpectedStatus, enabled: b.Enabled == nil || *b.Enabled}
	if v.environment == "" || utf8.RuneCountInString(v.environment) > 64 {
		return v, bad("environment must be 1 to 64 characters")
	}
	if v.expected == 0 {
		v.expected = http.StatusOK
	}
	if v.expected < 100 || v.expected > 599 {
		return v, bad("expected_status must be from 100 to 599")
	}
	u, err := alerts.ValidateHealthCheckURL(b.URL, s.healthChecksPrivate)
	if err != nil {
		return v, bad(err.Error())
	}
	v.url = u
	return v, nil
}

func toHealthCheck(h db.HealthCheck) HealthCheck {
	out := HealthCheck{
		ID: h.ID.String(), AppID: h.AppID.String(), Environment: h.Environment, URL: h.Url,
		ExpectedStatus: h.ExpectedStatus, Enabled: h.Enabled, Status: h.Status, StatusSince: h.StatusSince.UTC(),
		CheckedAt: utcPtr(h.CheckedAt), LastResult: decodeProbe(h.LastResult),
		CreatedAt: h.CreatedAt.UTC(), UpdatedAt: h.UpdatedAt.UTC(),
	}
	if h.CreatedBy != nil {
		u := h.CreatedBy.String()
		out.CreatedBy = &u
	}
	return out
}

// decodeProbe reads a stored alerts.HealthCheckResult; nil when there is
// none or it does not decode.
func decodeProbe(b []byte) *HealthCheckProbe {
	if len(b) == 0 {
		return nil
	}
	var r alerts.HealthCheckResult
	if err := json.Unmarshal(b, &r); err != nil {
		return nil
	}
	return &HealthCheckProbe{
		OK: r.OK, StatusCode: r.StatusCode, ExpectedStatus: r.ExpectedStatus, LatencyMS: r.LatencyMS, Error: r.Error,
		BodySnippet: r.BodySnippet, BodyTruncated: r.BodyTruncated, Attempts: r.Attempts, CheckedAt: r.CheckedAt.UTC(),
	}
}
