package query

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"slices"
	"strconv"
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
	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Alerts: a project's threshold alert rules, the notification channels they
// notify, the events (incidents) they raise and the incidents feed (events
// grouped by rule). Everyone who can view the project (and its read key)
// reads them; project admins (manage_alerts: project admins, organization
// owners and admins) create, change and delete rules and channels and send
// test notifications. A channel's config (recipients, webhook URLs, signing
// secrets) is sealed at rest and never returned.

// The alert operations' paths. The project is {project}, its slug, as
// authz.Guard reads it.
const (
	AlertRulesPath       = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/alerts/rules"
	AlertRulePath        = AlertRulesPath + "/{id}"
	AlertChannelsPath    = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/alerts/channels"
	AlertChannelPath     = AlertChannelsPath + "/{id}"
	AlertChannelTestPath = AlertChannelPath + "/test"
	AlertEventsPath      = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/alerts/events"
	IncidentsPath        = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/incidents"
)

// Limits of alert rules and channels.
const (
	maxAlertNameLen        = 128
	maxAlertDescriptionLen = 1024
	maxRuleChannels        = 20
)

// AlertPool is the Postgres pool the alert operations use, with
// transactions for deleting a channel; *pgxpool.Pool satisfies it.
type AlertPool interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// TestNotification is what a ChannelTester sends: one channel of a project
// with its opened config.
type TestNotification struct {
	ProjectID   uuid.UUID
	ProjectSlug string
	ChannelID   uuid.UUID
	Type        alerts.ChannelType
	Name        string
	Config      json.RawMessage
}

// ChannelTester sends a test notification through a channel. Only an
// *alerts.DeliveryError (failure class and status code) is shown to the
// caller; any other error is reduced to a generic message and never logged,
// since it may carry the channel's secrets (a webhook URL is a bearer
// secret).
type ChannelTester interface {
	SendTest(ctx context.Context, n TestNotification) error
}

type alertDeps struct {
	pool   AlertPool
	sealer *idkeys.Sealer // nil: channel writes and tests answer 503
	tester ChannelTester  // nil: channel tests answer 503
}

// WithAlerts enables the alert operations; without it they answer 503.
// sealer seals channel configs with the identity key-encryption key; nil
// makes creating, changing and testing channels answer 503. tester sends
// test notifications; nil makes the test operation answer 503.
func (s *Service) WithAlerts(pool AlertPool, sealer *idkeys.Sealer, tester ChannelTester) *Service {
	s.alerts = &alertDeps{pool: pool, sealer: sealer, tester: tester}
	return s
}

// ---------------------------------------------------------------- types

// AlertFilters narrow the requests a rule counts; every field is optional.
type AlertFilters struct {
	Consumer string `json:"consumer,omitempty" maxLength:"256" doc:"Only requests of this consumer id, as the SDK reports it."`
	Group    string `json:"group,omitempty" maxLength:"36" doc:"Only requests of the members of this consumer group (its id)."`
	Endpoint string `json:"endpoint,omitempty" maxLength:"512" doc:"Only requests of this endpoint: \"METHOD /route/{template}\", or \"/route/{template}\" for every method."`
}

// AlertRuleState is where a rule stands after its latest evaluation.
type AlertRuleState struct {
	Status      string    `json:"status" enum:"ok,pending,triggered,resolving" doc:"Trigger/resolve state: pending while the breach waits out notify_after_s, resolving while the clear waits out resolve_after_s."`
	Since       time.Time `json:"since" doc:"When the rule entered status."`
	EvaluatedAt time.Time `json:"evaluated_at"`
	Value       *float64  `json:"value" required:"true" nullable:"true" doc:"The metric over the latest window; null when the window had no data."`
	Breached    bool      `json:"breached"`
}

// AlertRule is a threshold rule over one app and environment.
type AlertRule struct {
	ID            string          `json:"id" format:"uuid"`
	AppID         string          `json:"app_id" format:"uuid"`
	Environment   string          `json:"environment"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Metric        string          `json:"metric" enum:"traffic,errors,error_rate,p50,p75,p95,apdex,unique_consumers"`
	Condition     string          `json:"condition" enum:"gt,gte,lt,lte"`
	Threshold     float64         `json:"threshold"`
	WindowS       int32           `json:"window_s"`
	EveryS        *int32          `json:"every_s" required:"true" nullable:"true" doc:"Evaluation frequency in seconds; null when cron is set."`
	Cron          *string         `json:"cron" required:"true" nullable:"true" doc:"Evaluation schedule (five cron fields, UTC); null when every_s is set."`
	NotifyAfterS  int32           `json:"notify_after_s"`
	ResolveAfterS int32           `json:"resolve_after_s"`
	Filters       AlertFilters    `json:"filters"`
	ChannelIDs    []string        `json:"channel_ids" doc:"The notification channels the rule notifies."`
	Enabled       bool            `json:"enabled"`
	State         *AlertRuleState `json:"state,omitempty" doc:"The latest evaluation; omitted before the first."`
	CreatedBy     *string         `json:"created_by" required:"true" nullable:"true" format:"uuid"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

// AlertRuleBody is the editable part of a rule. It is exported because Huma
// skips unexported embedded fields: createAlertRuleBody embeds it, and an
// unexported type left its fields out of the create schema, so every create
// was refused with "unexpected property".
type AlertRuleBody struct {
	Environment   string       `json:"environment" minLength:"1" maxLength:"64" doc:"The environment whose requests the rule counts."`
	Name          string       `json:"name" minLength:"1" maxLength:"128" doc:"Display name; surrounding spaces are dropped."`
	Description   string       `json:"description,omitempty" maxLength:"1024"`
	Metric        string       `json:"metric" enum:"traffic,errors,error_rate,p50,p75,p95,apdex,unique_consumers" doc:"What the rule aggregates over its window: request count, error count, error rate (0 to 1), p50/p75/p95 response time in ms, Apdex (0 to 1) or unique consumers."`
	Condition     string       `json:"condition" enum:"gt,gte,lt,lte" doc:"How the value compares to threshold for the rule to breach."`
	Threshold     float64      `json:"threshold" doc:"Not negative; at most 1 for error_rate and apdex."`
	WindowS       int32        `json:"window_s" minimum:"60" maximum:"86400" multipleOf:"60" doc:"The trailing window the metric is aggregated over, in whole minutes."`
	EveryS        *int32       `json:"every_s,omitempty" required:"false" minimum:"60" maximum:"86400" doc:"Evaluation frequency in seconds. Exactly one of every_s and cron."`
	Cron          *string      `json:"cron,omitempty" required:"false" minLength:"1" maxLength:"128" doc:"Evaluation schedule: five cron fields (minute hour day-of-month month day-of-week, UTC) or a descriptor such as @hourly. Exactly one of every_s and cron."`
	NotifyAfterS  int32        `json:"notify_after_s,omitempty" minimum:"0" maximum:"86400" doc:"How long the breach must hold before the first notification."`
	ResolveAfterS int32        `json:"resolve_after_s,omitempty" minimum:"0" maximum:"86400" doc:"How long the breach must clear before the event resolves."`
	Filters       AlertFilters `json:"filters,omitempty" required:"false"`
	ChannelIDs    []string     `json:"channel_ids,omitempty" required:"false" maxItems:"20" doc:"Notification channels of the project to notify."`
	Enabled       *bool        `json:"enabled,omitempty" required:"false" doc:"Whether the rule is evaluated; omitted means true."`
}

type createAlertRuleBody struct {
	AppID string `json:"app_id" format:"uuid" doc:"The app whose requests the rule counts; it never changes."`
	AlertRuleBody
}

// NotificationChannel is where a project's alert notifications go. Its
// config is write-only.
type NotificationChannel struct {
	ID        string    `json:"id" format:"uuid"`
	Type      string    `json:"type" enum:"email,slack,teams,webhook"`
	Name      string    `json:"name"`
	CreatedBy *string   `json:"created_by" required:"true" nullable:"true" format:"uuid"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AlertEvent is one incident of a rule.
type AlertEvent struct {
	ID          string     `json:"id" format:"uuid"`
	RuleID      string     `json:"rule_id" format:"uuid"`
	RuleName    string     `json:"rule_name"`
	AppID       string     `json:"app_id" format:"uuid"`
	Environment string     `json:"environment"`
	Metric      string     `json:"metric"`
	State       string     `json:"state" enum:"triggered,resolved"`
	Value       float64    `json:"value" doc:"The metric value that triggered the event."`
	StartedAt   time.Time  `json:"started_at"`
	EndedAt     *time.Time `json:"ended_at" required:"true" nullable:"true"`
	NotifiedAt  *time.Time `json:"notified_at" required:"true" nullable:"true" doc:"When the first notification went out; null until then."`
}

// Incident is a rule's events in the incidents feed.
type Incident struct {
	RuleID         string     `json:"rule_id" format:"uuid"`
	RuleName       string     `json:"rule_name"`
	AppID          string     `json:"app_id" format:"uuid"`
	Environment    string     `json:"environment"`
	Metric         string     `json:"metric"`
	Condition      string     `json:"condition"`
	Threshold      float64    `json:"threshold"`
	Status         string     `json:"status" enum:"ok,pending,triggered,resolving" doc:"The rule's trigger/resolve state now."`
	Open           bool       `json:"open" doc:"Whether the latest event is still triggered."`
	Events         int64      `json:"events" doc:"Events of the rule started in the range, plus one still open from before it."`
	FirstStartedAt time.Time  `json:"first_started_at"`
	Latest         AlertEvent `json:"latest" doc:"The rule's latest event."`
}

// ---------------------------------------------------------------- inputs

type projectPathInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
}

type alertIDInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid"`
}

type createAlertRuleInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	Body    createAlertRuleBody
}

type updateAlertRuleInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid"`
	Body    AlertRuleBody
}

type createChannelInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	Body    struct {
		Type   string         `json:"type" enum:"email,slack,teams,webhook"`
		Name   string         `json:"name" minLength:"1" maxLength:"128" doc:"Display name, unique in the project; surrounding spaces are dropped."`
		Config map[string]any `json:"config" doc:"Write-only channel config, sealed at rest and never returned. email: {\"addresses\": [\"oncall@example.com\", ...]} (1 to 20 plain addresses); slack and teams: {\"webhook_url\": \"https://...\"} (the incoming webhook URL); webhook: {\"url\": \"https://...\", \"secret\": \"...\"} (secret of at least 16 characters, signs every request). URLs must be https without credentials or a fragment; unknown keys are refused."`
	}
}

type updateChannelInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid"`
	Body    struct {
		Name   string         `json:"name" minLength:"1" maxLength:"128" doc:"Display name, unique in the project; surrounding spaces are dropped."`
		Config map[string]any `json:"config,omitempty" required:"false" doc:"Replaces the channel config (same shape as on create); omitted keeps the current one. The type never changes."`
	}
}

type listAlertEventsInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	RuleID  string `query:"rule_id" format:"uuid" doc:"Only the events of this rule."`
	State   string `query:"state" enum:"triggered,resolved" doc:"Only events in this state."`
	Limit   int    `query:"limit" minimum:"1" maximum:"200" default:"50"`
	Cursor  string `query:"cursor" maxLength:"256" doc:"next_cursor of the previous page; omitted means the first page."`
}

type listIncidentsInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	Range   string `query:"range" enum:"24h,7d,30d" default:"7d" doc:"Count the events started in this range ending now; open events always count."`
	Limit   int    `query:"limit" minimum:"1" maximum:"200" default:"100"`
}

// ---------------------------------------------------------------- outputs

type alertRuleOutput struct{ Body AlertRule }

type alertRulesOutput struct {
	Body struct {
		Rules []AlertRule `json:"rules" doc:"The project's rules by name; rules of deleted apps are left out."`
	}
}

type channelOutput struct{ Body NotificationChannel }

type channelsOutput struct {
	Body struct {
		Channels []NotificationChannel `json:"channels" doc:"The project's channels by name."`
	}
}

type channelTestOutput struct {
	Body struct {
		Sent bool `json:"sent" doc:"Always true; a failed send answers 502. Email is queued for sending."`
	}
}

type alertEventsOutput struct {
	Body struct {
		Events     []AlertEvent `json:"events" doc:"Newest first."`
		NextCursor string       `json:"next_cursor" doc:"Pass as cursor for the next (older) page; empty on the last page."`
	}
}

type incidentsOutput struct {
	Body struct {
		Range     string     `json:"range"`
		Incidents []Incident `json:"incidents" doc:"One per rule with events: open ones first, then by latest event, newest first."`
	}
}

// ---------------------------------------------------------------- register

func registerAlerts(api huma.API, s *Service, guard *authz.Guard) {
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

	huma.Register(api, op("list-alert-rules", http.MethodGet, AlertRulesPath, "List the alert rules of a project",
		"The project's alert rules by name, each with its latest evaluation.", false, 0), s.listAlertRules)
	huma.Register(api, op("create-alert-rule", http.MethodPost, AlertRulesPath, "Create an alert rule",
		"Creates a threshold rule over one app and environment. Exactly one of every_s and cron sets when it is evaluated. "+
			"An app or channel that is not the project's answers 422.", true, http.StatusCreated), s.createAlertRule)
	huma.Register(api, op("get-alert-rule", http.MethodGet, AlertRulePath, "Get an alert rule",
		"One rule with its latest evaluation.", false, 0), s.getAlertRule)
	huma.Register(api, op("update-alert-rule", http.MethodPut, AlertRulePath, "Replace an alert rule",
		"Replaces every editable field of a rule; its app never changes.", true, 0), s.updateAlertRule)
	huma.Register(api, op("delete-alert-rule", http.MethodDelete, AlertRulePath, "Delete an alert rule",
		"Deletes a rule and its events.", true, http.StatusNoContent), s.deleteAlertRule)

	huma.Register(api, op("list-notification-channels", http.MethodGet, AlertChannelsPath, "List the notification channels of a project",
		"The project's channels by name. Configs are never returned.", false, 0), s.listChannels)
	huma.Register(api, op("create-notification-channel", http.MethodPost, AlertChannelsPath, "Create a notification channel",
		"Creates an email, Slack, Teams or webhook channel. A name the project already uses answers 409.", true, http.StatusCreated), s.createChannel)
	huma.Register(api, op("get-notification-channel", http.MethodGet, AlertChannelPath, "Get a notification channel",
		"One channel, without its config.", false, 0), s.getChannel)
	huma.Register(api, op("update-notification-channel", http.MethodPut, AlertChannelPath, "Update a notification channel",
		"Renames a channel and, when config is sent, replaces its config. A name the project already uses answers 409.", true, 0), s.updateChannel)
	huma.Register(api, op("delete-notification-channel", http.MethodDelete, AlertChannelPath, "Delete a notification channel",
		"Deletes a channel and removes it from every rule that notifies it.", true, http.StatusNoContent), s.deleteChannel)
	huma.Register(api, op("test-notification-channel", http.MethodPost, AlertChannelTestPath, "Send a test notification",
		"Sends a test notification through the channel now (email is queued). 502 when the channel does not accept it, with only the failure class or HTTP status, never the channel's secrets.",
		true, 0), s.testChannel)

	huma.Register(api, op("list-alert-events", http.MethodGet, AlertEventsPath, "List alert events",
		"The project's alert events (one per incident), newest first, with cursor pagination.", false, 0), s.listAlertEvents)
	huma.Register(api, op("list-incidents", http.MethodGet, IncidentsPath, "Incidents feed",
		"The project's alert events grouped by rule: each rule with events in the range (or one still open), its latest event and its state now.",
		false, 0), s.listIncidents)
}

// alertScope is the project the guard authorized and the alert queries.
func (s *Service) alertScope(ctx context.Context) (*db.Queries, uuid.UUID, error) {
	t, ok := authz.TargetFromContext(ctx)
	if !ok {
		return nil, uuid.Nil, identity.Err(identity.CodeUnauthenticated)
	}
	if s.alerts == nil || s.alerts.pool == nil {
		return nil, uuid.Nil, huma.Error503ServiceUnavailable("alerts unavailable")
	}
	return db.New(s.alerts.pool), t.ProjectID, nil
}

// alertUser is the signed-in user of a write.
func alertUser(ctx context.Context) (*uuid.UUID, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, huma.Error401Unauthorized("a user session is required")
	}
	id := p.UserID
	return &id, nil
}

// ---------------------------------------------------------------- rules

func (s *Service) listAlertRules(ctx context.Context, _ *projectPathInput) (*alertRulesOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := q.ListAlertRules(ctx, project)
	if err != nil {
		return nil, internalError("list alert rules", err)
	}
	states, err := q.ListAlertRuleStates(ctx, project)
	if err != nil {
		return nil, internalError("alert rule states", err)
	}
	byRule := make(map[uuid.UUID]db.AlertRuleState, len(states))
	for _, st := range states {
		byRule[st.RuleID] = st
	}
	out := &alertRulesOutput{}
	out.Body.Rules = make([]AlertRule, 0, len(rows))
	for _, r := range rows {
		var st *db.AlertRuleState
		if v, ok := byRule[r.ID]; ok {
			st = &v
		}
		out.Body.Rules = append(out.Body.Rules, toAlertRule(r, st))
	}
	return out, nil
}

func (s *Service) getAlertRule(ctx context.Context, in *alertIDInput) (*alertRuleOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadAlertRule(ctx, q, project, in.ID)
	if err != nil {
		return nil, err
	}
	return s.alertRuleWithState(ctx, q, r)
}

func (s *Service) createAlertRule(ctx context.Context, in *createAlertRuleInput) (*alertRuleOutput, error) {
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
	v, err := validateRule(ctx, q, project, in.Body.AlertRuleBody)
	if err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, internalError("rule id", err)
	}
	r, err := q.CreateAlertRule(ctx, db.CreateAlertRuleParams{
		ID: id, ProjectID: project, AppID: appID, Environment: v.environment, Name: v.name, Description: v.description,
		Metric: v.metric, Condition: v.condition, Threshold: v.threshold, WindowS: v.windowS, EveryS: v.everyS, Cron: v.cron,
		NotifyAfterS: v.notifyAfterS, ResolveAfterS: v.resolveAfterS, Filters: v.filters, ChannelIds: v.channelIDs,
		Enabled: v.enabled, CreatedBy: user,
	})
	if err != nil {
		return nil, internalError("create alert rule", err)
	}
	return &alertRuleOutput{Body: toAlertRule(r, nil)}, nil
}

func (s *Service) updateAlertRule(ctx context.Context, in *updateAlertRuleInput) (*alertRuleOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := alertUser(ctx); err != nil {
		return nil, err
	}
	cur, err := s.loadAlertRule(ctx, q, project, in.ID)
	if err != nil {
		return nil, err
	}
	v, err := validateRule(ctx, q, project, in.Body)
	if err != nil {
		return nil, err
	}
	r, err := q.UpdateAlertRule(ctx, db.UpdateAlertRuleParams{
		ID: cur.ID, ProjectID: project, Environment: v.environment, Name: v.name, Description: v.description,
		Metric: v.metric, Condition: v.condition, Threshold: v.threshold, WindowS: v.windowS, EveryS: v.everyS, Cron: v.cron,
		NotifyAfterS: v.notifyAfterS, ResolveAfterS: v.resolveAfterS, Filters: v.filters, ChannelIds: v.channelIDs,
		Enabled: v.enabled,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("alert rule not found")
	}
	if err != nil {
		return nil, internalError("update alert rule", err)
	}
	return s.alertRuleWithState(ctx, q, r)
}

func (s *Service) deleteAlertRule(ctx context.Context, in *alertIDInput) (*struct{}, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("alert rule not found")
	}
	n, err := q.DeleteAlertRule(ctx, db.DeleteAlertRuleParams{ProjectID: project, ID: id})
	if err != nil {
		return nil, internalError("delete alert rule", err)
	}
	if n == 0 {
		return nil, huma.Error404NotFound("alert rule not found")
	}
	return nil, nil
}

// loadAlertRule reads one rule of the project; rules of deleted apps are
// not found, as in the list.
func (s *Service) loadAlertRule(ctx context.Context, q *db.Queries, project uuid.UUID, rawID string) (db.AlertRule, error) {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return db.AlertRule{}, huma.Error404NotFound("alert rule not found")
	}
	r, err := q.GetAlertRule(ctx, db.GetAlertRuleParams{ProjectID: project, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.AlertRule{}, huma.Error404NotFound("alert rule not found")
	}
	if err != nil {
		return db.AlertRule{}, internalError("alert rule", err)
	}
	if err := s.checkRuleApp(ctx, project, r.AppID); err != nil {
		return db.AlertRule{}, huma.Error404NotFound("alert rule not found")
	}
	return r, nil
}

func (s *Service) alertRuleWithState(ctx context.Context, q *db.Queries, r db.AlertRule) (*alertRuleOutput, error) {
	st, err := q.GetAlertRuleState(ctx, r.ID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return &alertRuleOutput{Body: toAlertRule(r, nil)}, nil
	case err != nil:
		return nil, internalError("alert rule state", err)
	}
	return &alertRuleOutput{Body: toAlertRule(r, &st)}, nil
}

// checkRuleApp answers 422 unless app is an active app of the project.
func (s *Service) checkRuleApp(ctx context.Context, project, app uuid.UUID) error {
	apps, err := s.catalog.ListProjectApps(ctx, project)
	if err != nil {
		return internalError("app lookup", err)
	}
	for _, a := range apps {
		if a.ID == app {
			return nil
		}
	}
	return huma.Error422UnprocessableEntity("app_id is not an app of the project")
}

// validRule is a checked rule body, ready for the store.
type validRule struct {
	environment, name, description string
	metric, condition              string
	threshold                      float64
	windowS                        int32
	everyS                         *int32
	cron                           *string
	notifyAfterS, resolveAfterS    int32
	filters                        []byte
	channelIDs                     []uuid.UUID
	enabled                        bool
}

// validateRule checks a rule body beyond what its schema does: names,
// thresholds per metric, the schedule, filters and channels.
func validateRule(ctx context.Context, q *db.Queries, project uuid.UUID, b AlertRuleBody) (validRule, error) {
	v, err := checkRuleFields(b)
	if err != nil {
		return v, err
	}
	if v.filters, err = checkRuleFilters(ctx, q, project, b.Filters); err != nil {
		return v, err
	}
	if len(v.channelIDs) > 0 {
		found, err := q.ListNotificationChannelsByIDs(ctx, db.ListNotificationChannelsByIDsParams{ProjectID: project, Ids: v.channelIDs})
		if err != nil {
			return v, internalError("channel lookup", err)
		}
		if len(found) != len(v.channelIDs) {
			return v, huma.Error422UnprocessableEntity("channel_ids names a channel that is not one of the project's")
		}
	}
	return v, nil
}

// checkRuleFields checks the fields of a rule body that need no store.
func checkRuleFields(b AlertRuleBody) (validRule, error) {
	bad := huma.Error422UnprocessableEntity
	v := validRule{
		environment: strings.TrimSpace(b.Environment), name: strings.TrimSpace(b.Name),
		description: strings.TrimSpace(b.Description), metric: b.Metric, condition: b.Condition,
		threshold: b.Threshold, windowS: b.WindowS, everyS: b.EveryS, notifyAfterS: b.NotifyAfterS,
		resolveAfterS: b.ResolveAfterS, enabled: b.Enabled == nil || *b.Enabled,
	}
	if v.name == "" || utf8.RuneCountInString(v.name) > maxAlertNameLen {
		return v, bad("name must be 1 to 128 characters")
	}
	if v.environment == "" || utf8.RuneCountInString(v.environment) > 64 {
		return v, bad("environment must be 1 to 64 characters")
	}
	if utf8.RuneCountInString(v.description) > maxAlertDescriptionLen {
		return v, bad("description must be at most 1024 characters")
	}
	m, c := alerts.Metric(b.Metric), alerts.Condition(b.Condition)
	if !m.Valid() {
		return v, bad("unknown metric")
	}
	if !c.Valid() {
		return v, bad("unknown condition")
	}
	if math.IsNaN(b.Threshold) || math.IsInf(b.Threshold, 0) || b.Threshold < 0 {
		return v, bad("threshold must be a number of at least 0")
	}
	if (m == alerts.MetricErrorRate || m == alerts.MetricApdex) && b.Threshold > 1 {
		return v, bad("threshold of " + b.Metric + " must be between 0 and 1")
	}
	if b.WindowS < 60 || b.WindowS > 86400 || b.WindowS%60 != 0 {
		return v, bad("window_s must be whole minutes from 60 to 86400")
	}
	if b.Cron != nil {
		spec := strings.TrimSpace(*b.Cron)
		b.Cron = &spec
	}
	switch {
	case (b.EveryS == nil) == (b.Cron == nil || *b.Cron == ""):
		return v, bad("set exactly one of every_s and cron")
	case b.EveryS != nil && (*b.EveryS < 60 || *b.EveryS > 86400):
		return v, bad("every_s must be from 60 to 86400")
	case b.Cron != nil:
		if len(*b.Cron) > 128 {
			return v, bad("cron must be at most 128 characters")
		}
		if _, err := alerts.ParseCron(*b.Cron); err != nil {
			return v, bad("cron is not a valid schedule (five fields: minute hour day-of-month month day-of-week)")
		}
		v.cron = b.Cron
	}
	if b.NotifyAfterS < 0 || b.NotifyAfterS > 86400 || b.ResolveAfterS < 0 || b.ResolveAfterS > 86400 {
		return v, bad("notify_after_s and resolve_after_s must be from 0 to 86400")
	}
	if len(b.ChannelIDs) > maxRuleChannels {
		return v, bad("a rule notifies at most 20 channels")
	}
	v.channelIDs = make([]uuid.UUID, 0, len(b.ChannelIDs))
	for _, raw := range b.ChannelIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			return v, bad("channel_ids must be channel ids")
		}
		if !slices.Contains(v.channelIDs, id) {
			v.channelIDs = append(v.channelIDs, id)
		}
	}
	return v, nil
}

// checkRuleFilters trims the filters, checks the group is one of the
// project's and encodes them for alert_rules.filters.
func checkRuleFilters(ctx context.Context, q *db.Queries, project uuid.UUID, f AlertFilters) ([]byte, error) {
	f = AlertFilters{Consumer: strings.TrimSpace(f.Consumer), Group: strings.TrimSpace(f.Group), Endpoint: strings.TrimSpace(f.Endpoint)}
	if f.Group != "" {
		id, err := uuid.Parse(f.Group)
		if err != nil {
			return nil, huma.Error422UnprocessableEntity("filters.group is not a consumer group of the project")
		}
		if _, err := q.GetConsumerGroup(ctx, db.GetConsumerGroupParams{ID: id, ProjectID: project}); errors.Is(err, pgx.ErrNoRows) {
			return nil, huma.Error422UnprocessableEntity("filters.group is not a consumer group of the project")
		} else if err != nil {
			return nil, internalError("consumer group", err)
		}
		f.Group = id.String()
	}
	b, err := json.Marshal(f)
	if err != nil {
		return nil, internalError("filters", err)
	}
	return b, nil
}

func toAlertRule(r db.AlertRule, st *db.AlertRuleState) AlertRule {
	out := AlertRule{
		ID: r.ID.String(), AppID: r.AppID.String(), Environment: r.Environment, Name: r.Name, Description: r.Description,
		Metric: r.Metric, Condition: r.Condition, Threshold: r.Threshold, WindowS: r.WindowS, EveryS: r.EveryS, Cron: r.Cron,
		NotifyAfterS: r.NotifyAfterS, ResolveAfterS: r.ResolveAfterS, Enabled: r.Enabled,
		ChannelIDs: make([]string, 0, len(r.ChannelIds)), CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
	}
	if f, err := alerts.ParseFilters(r.Filters); err == nil {
		out.Filters = AlertFilters{Consumer: f.Consumer, Group: f.Group, Endpoint: f.Endpoint}
	}
	for _, id := range r.ChannelIds {
		out.ChannelIDs = append(out.ChannelIDs, id.String())
	}
	if r.CreatedBy != nil {
		u := r.CreatedBy.String()
		out.CreatedBy = &u
	}
	if st != nil {
		out.State = &AlertRuleState{
			Status: st.Status, Since: st.StatusSince.UTC(), EvaluatedAt: st.EvaluatedAt.UTC(), Value: st.Value, Breached: st.Breached,
		}
	}
	return out
}

// ---------------------------------------------------------------- channels

func (s *Service) listChannels(ctx context.Context, _ *projectPathInput) (*channelsOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := q.ListNotificationChannels(ctx, project)
	if err != nil {
		return nil, internalError("list notification channels", err)
	}
	out := &channelsOutput{}
	out.Body.Channels = make([]NotificationChannel, 0, len(rows))
	for _, r := range rows {
		out.Body.Channels = append(out.Body.Channels, toChannel(r))
	}
	return out, nil
}

func (s *Service) getChannel(ctx context.Context, in *alertIDInput) (*channelOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	ch, err := loadChannel(ctx, q, project, in.ID)
	if err != nil {
		return nil, err
	}
	return &channelOutput{Body: toChannel(ch)}, nil
}

func (s *Service) createChannel(ctx context.Context, in *createChannelInput) (*channelOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	user, err := alertUser(ctx)
	if err != nil {
		return nil, err
	}
	sealer, err := s.channelSealer()
	if err != nil {
		return nil, err
	}
	name, err := channelName(in.Body.Name)
	if err != nil {
		return nil, err
	}
	typ := alerts.ChannelType(in.Body.Type)
	config, err := channelConfig(typ, in.Body.Config)
	if err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, internalError("channel id", err)
	}
	sealed, err := alerts.SealChannelConfig(sealer, id, config)
	if err != nil {
		return nil, internalError("seal channel config", err)
	}
	ch, err := q.CreateNotificationChannel(ctx, db.CreateNotificationChannelParams{
		ID: id, ProjectID: project, Type: string(typ), Name: name, ConfigEnc: sealed, CreatedBy: user,
	})
	if isUniqueViolation(err) {
		return nil, huma.Error409Conflict("the project already has a notification channel with this name")
	}
	if err != nil {
		return nil, internalError("create notification channel", err)
	}
	return &channelOutput{Body: toChannel(ch)}, nil
}

func (s *Service) updateChannel(ctx context.Context, in *updateChannelInput) (*channelOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := alertUser(ctx); err != nil {
		return nil, err
	}
	sealer, err := s.channelSealer()
	if err != nil {
		return nil, err
	}
	name, err := channelName(in.Body.Name)
	if err != nil {
		return nil, err
	}
	cur, err := loadChannel(ctx, q, project, in.ID)
	if err != nil {
		return nil, err
	}
	sealed := cur.ConfigEnc
	if in.Body.Config != nil {
		config, err := channelConfig(alerts.ChannelType(cur.Type), in.Body.Config)
		if err != nil {
			return nil, err
		}
		if sealed, err = alerts.SealChannelConfig(sealer, cur.ID, config); err != nil {
			return nil, internalError("seal channel config", err)
		}
	}
	ch, err := q.UpdateNotificationChannel(ctx, db.UpdateNotificationChannelParams{
		ProjectID: project, ID: cur.ID, Name: name, ConfigEnc: sealed,
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, huma.Error404NotFound("notification channel not found")
	case isUniqueViolation(err):
		return nil, huma.Error409Conflict("the project already has a notification channel with this name")
	case err != nil:
		return nil, internalError("update notification channel", err)
	}
	return &channelOutput{Body: toChannel(ch)}, nil
}

func (s *Service) deleteChannel(ctx context.Context, in *alertIDInput) (*struct{}, error) {
	_, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("notification channel not found")
	}
	tx, err := s.alerts.pool.Begin(ctx)
	if err != nil {
		return nil, internalError("delete notification channel", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	n, err := q.DeleteNotificationChannel(ctx, db.DeleteNotificationChannelParams{ProjectID: project, ID: id})
	if err != nil {
		return nil, internalError("delete notification channel", err)
	}
	if n == 0 {
		return nil, huma.Error404NotFound("notification channel not found")
	}
	if _, err := q.RemoveChannelFromAlertRules(ctx, db.RemoveChannelFromAlertRulesParams{ProjectID: project, ChannelID: id}); err != nil {
		return nil, internalError("delete notification channel", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, internalError("delete notification channel", err)
	}
	return nil, nil
}

func (s *Service) testChannel(ctx context.Context, in *alertIDInput) (*channelTestOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := alertUser(ctx); err != nil {
		return nil, err
	}
	sealer, err := s.channelSealer()
	if err != nil {
		return nil, err
	}
	if s.alerts.tester == nil {
		return nil, huma.Error503ServiceUnavailable("notification delivery unavailable")
	}
	ch, err := loadChannel(ctx, q, project, in.ID)
	if err != nil {
		return nil, err
	}
	config, err := alerts.OpenChannelConfig(sealer, ch.ID, ch.ConfigEnc)
	if err != nil {
		return nil, internalError("open channel config", err)
	}
	if err := s.alerts.tester.SendTest(ctx, TestNotification{
		ProjectID: project, ProjectSlug: in.Project, ChannelID: ch.ID, Type: alerts.ChannelType(ch.Type), Name: ch.Name, Config: config,
	}); err != nil {
		// Only a DeliveryError is free of the channel's secrets.
		var de *alerts.DeliveryError
		if errors.As(err, &de) {
			return nil, huma.Error502BadGateway("the channel did not accept the test notification: " + de.Error())
		}
		return nil, huma.Error502BadGateway("the channel did not accept the test notification")
	}
	out := &channelTestOutput{}
	out.Body.Sent = true
	return out, nil
}

func (s *Service) channelSealer() (*idkeys.Sealer, error) {
	if s.alerts == nil || s.alerts.sealer == nil {
		return nil, huma.Error503ServiceUnavailable("notification channel encryption is not configured")
	}
	return s.alerts.sealer, nil
}

func loadChannel(ctx context.Context, q *db.Queries, project uuid.UUID, rawID string) (db.NotificationChannel, error) {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return db.NotificationChannel{}, huma.Error404NotFound("notification channel not found")
	}
	ch, err := q.GetNotificationChannel(ctx, db.GetNotificationChannelParams{ProjectID: project, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.NotificationChannel{}, huma.Error404NotFound("notification channel not found")
	}
	if err != nil {
		return db.NotificationChannel{}, internalError("notification channel", err)
	}
	return ch, nil
}

func channelName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxAlertNameLen {
		return "", huma.Error422UnprocessableEntity("name must be 1 to 128 characters")
	}
	return name, nil
}

func toChannel(r db.NotificationChannel) NotificationChannel {
	out := NotificationChannel{
		ID: r.ID.String(), Type: r.Type, Name: r.Name, CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
	}
	if r.CreatedBy != nil {
		u := r.CreatedBy.String()
		out.CreatedBy = &u
	}
	return out
}

// channelConfig checks a channel config against its type (see
// alerts.ParseChannelConfig) and returns it as JSON for sealing. The 422 it
// answers never quotes the config's values.
func channelConfig(t alerts.ChannelType, config map[string]any) (json.RawMessage, error) {
	if !t.Valid() {
		return nil, huma.Error422UnprocessableEntity("unknown channel type")
	}
	if config == nil {
		return nil, huma.Error422UnprocessableEntity("config is required")
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return nil, huma.Error422UnprocessableEntity("config must be a JSON object")
	}
	if _, err := alerts.ParseChannelConfig(t, raw); err != nil {
		return nil, huma.Error422UnprocessableEntity(strings.TrimPrefix(err.Error(), "alerts: "))
	}
	return raw, nil
}

// ---------------------------------------------------------------- events

// eventCursor is the keyset position of the last event of a page.
type eventCursor struct {
	startedAt time.Time
	id        uuid.UUID
}

func (c eventCursor) encode() string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(c.startedAt.UnixMicro(), 10) + ":" + c.id.String()))
}

func decodeEventCursor(s string) (eventCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return eventCursor{}, err
	}
	usS, idS, ok := strings.Cut(string(raw), ":")
	if !ok {
		return eventCursor{}, errors.New("malformed cursor")
	}
	us, err := strconv.ParseInt(usS, 10, 64)
	if err != nil {
		return eventCursor{}, err
	}
	id, err := uuid.Parse(idS)
	if err != nil {
		return eventCursor{}, err
	}
	return eventCursor{startedAt: time.UnixMicro(us).UTC(), id: id}, nil
}

func (s *Service) listAlertEvents(ctx context.Context, in *listAlertEventsInput) (*alertEventsOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 50
	}
	arg := db.ListAlertEventsParams{ProjectID: project, RowLimit: int32(limit) + 1}
	if in.RuleID != "" {
		id, err := uuid.Parse(in.RuleID)
		if err != nil {
			return nil, huma.Error422UnprocessableEntity("rule_id must be a rule id")
		}
		arg.RuleID = &id
	}
	if in.State != "" {
		st := in.State
		arg.State = &st
	}
	if in.Cursor != "" {
		c, err := decodeEventCursor(in.Cursor)
		if err != nil {
			return nil, huma.Error422UnprocessableEntity("invalid cursor; pass next_cursor of the previous page")
		}
		arg.BeforeStartedAt, arg.BeforeID = &c.startedAt, &c.id
	}
	rows, err := q.ListAlertEvents(ctx, arg)
	if err != nil {
		return nil, internalError("list alert events", err)
	}
	out := &alertEventsOutput{}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		out.Body.NextCursor = eventCursor{startedAt: last.StartedAt, id: last.ID}.encode()
	}
	out.Body.Events = make([]AlertEvent, 0, len(rows))
	for _, r := range rows {
		out.Body.Events = append(out.Body.Events, AlertEvent{
			ID: r.ID.String(), RuleID: r.RuleID.String(), RuleName: r.RuleName, AppID: r.AppID.String(),
			Environment: r.Environment, Metric: r.Metric, State: r.State, Value: r.Value,
			StartedAt: r.StartedAt.UTC(), EndedAt: utcPtr(r.EndedAt), NotifiedAt: utcPtr(r.NotifiedAt),
		})
	}
	return out, nil
}

// incidentRanges are the incidents feed's ranges.
var incidentRanges = map[string]time.Duration{"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}

func (s *Service) listIncidents(ctx context.Context, in *listIncidentsInput) (*incidentsOutput, error) {
	q, project, err := s.alertScope(ctx)
	if err != nil {
		return nil, err
	}
	name := in.Range
	if name == "" {
		name = "7d"
	}
	span, ok := incidentRanges[name]
	if !ok {
		return nil, huma.Error422UnprocessableEntity("range must be one of 24h, 7d, 30d")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 100
	}
	rows, err := q.ListAlertIncidents(ctx, db.ListAlertIncidentsParams{
		ProjectID: project, Since: s.now().UTC().Add(-span), RowLimit: int32(limit),
	})
	if err != nil {
		return nil, internalError("list incidents", err)
	}
	out := &incidentsOutput{}
	out.Body.Range = name
	out.Body.Incidents = make([]Incident, 0, len(rows))
	for _, r := range rows {
		out.Body.Incidents = append(out.Body.Incidents, Incident{
			RuleID: r.RuleID.String(), RuleName: r.RuleName, AppID: r.AppID.String(), Environment: r.Environment,
			Metric: r.Metric, Condition: r.Condition, Threshold: r.Threshold, Status: r.Status,
			Open: r.LatestState == "triggered", Events: r.Events, FirstStartedAt: r.FirstStartedAt.UTC(),
			Latest: AlertEvent{
				ID: r.LatestEventID.String(), RuleID: r.RuleID.String(), RuleName: r.RuleName, AppID: r.AppID.String(),
				Environment: r.Environment, Metric: r.Metric, State: r.LatestState, Value: r.LatestValue,
				StartedAt: r.LatestStartedAt.UTC(), EndedAt: utcPtr(r.LatestEndedAt), NotifiedAt: utcPtr(r.LatestNotifiedAt),
			},
		})
	}
	return out, nil
}
