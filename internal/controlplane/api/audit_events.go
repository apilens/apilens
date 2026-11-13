package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/auditlog"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Audit event paths: a project's and an organization's events, and the
// actions they can be filtered by.
const (
	ProjectAuditEventsPath  = ProjectPath + "/audit-events"
	ProjectAuditActionsPath = ProjectAuditEventsPath + "/actions"
	OrgAuditEventsPath      = OrgPath + "/audit-events"
	OrgAuditActionsPath     = OrgAuditEventsPath + "/actions"
)

// AuditService lists audit events; *auditlog.Service satisfies it.
type AuditService interface {
	ListProject(ctx context.Context, project uuid.UUID, q audit.Query) (auditlog.Page, error)
	ListOrg(ctx context.Context, user, org uuid.UUID, q audit.Query) (auditlog.Page, error)
}

// AuditActor is who did an audited action.
type AuditActor struct {
	Type  string `json:"type" enum:"user,system" doc:"user: a person; system: APILens itself (a job, the SDK) or an anonymous caller."`
	ID    string `json:"id,omitempty" format:"uuid" doc:"The user's id; absent for system."`
	Label string `json:"label" doc:"The user's name (or email) when the event was recorded; \"System\" for system; empty when unknown."`
}

// AuditTarget is what an audited action acted on.
type AuditTarget struct {
	Type  string `json:"type" doc:"The kind of thing (api_key, member, app, project, ...)."`
	ID    string `json:"id"`
	Label string `json:"label" doc:"Its name when the event was recorded, readable after it is gone."`
}

// AuditProject names the project an event on the organization list belongs
// to.
type AuditProject struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// AuditEvent is one audit record.
type AuditEvent struct {
	ID        string         `json:"id"`
	Time      time.Time      `json:"time"`
	Action    string         `json:"action" doc:"The event kind, noun.verb (api_key.created). GET .../audit-events/actions lists them."`
	Actor     AuditActor     `json:"actor"`
	Target    *AuditTarget   `json:"target,omitempty" doc:"What was acted on; absent when nothing in particular (a sign-in)."`
	Project   *AuditProject  `json:"project,omitempty" doc:"On the organization list: the project of a project event; absent for an org-wide event."`
	IP        string         `json:"ip" doc:"The client IP of the request; empty when unknown."`
	UserAgent string         `json:"user_agent"`
	RequestID string         `json:"request_id" doc:"The X-Request-Id of the request that caused it; empty outside a request."`
	Changes   map[string]any `json:"changes" required:"true" nullable:"true" doc:"{\"previous\": ..., \"next\": ...} for a change; null otherwise. Never holds secrets."`
}

// ListAuditEventsQuery are the filters and page of an audit event listing.
type ListAuditEventsQuery struct {
	Actor      string `query:"actor" format:"uuid" doc:"Only events this user did."`
	Action     string `query:"action" maxLength:"100" doc:"Only this action (api_key.created), or every action with a prefix when it ends with a dot (api_key.)."`
	TargetType string `query:"target_type" maxLength:"100" doc:"Only events on this type of target (api_key)."`
	From       string `query:"from" format:"date-time" doc:"Only events at or after this time."`
	To         string `query:"to" format:"date-time" doc:"Only events before this time."`
	Q          string `query:"q" maxLength:"200" doc:"Only events whose target label contains this text (case-insensitive)."`
	Limit      int    `query:"limit" minimum:"1" maximum:"200" default:"50"`
	Cursor     string `query:"cursor" maxLength:"512" doc:"next_cursor of the previous page; omitted means the first page."`
}

// ListProjectAuditEventsInput is the request of GET /api/v1/projects/{slug}/audit-events.
type ListProjectAuditEventsInput struct {
	ProjectSlugInput
	ListAuditEventsQuery
}

// ListOrgAuditEventsInput is the request of GET /api/v1/orgs/{slug}/audit-events.
type ListOrgAuditEventsInput struct {
	OrgSlugInput
	ListAuditEventsQuery
}

// ListAuditEventsOutput is the response of an audit event listing.
type ListAuditEventsOutput struct {
	Body struct {
		Events     []AuditEvent `json:"events" doc:"Newest first."`
		NextCursor string       `json:"next_cursor" doc:"Pass as cursor for the next page; empty on the last page."`
		// RetentionDays is audit.retention, so the UI can say how far back
		// the log goes.
		RetentionDays int `json:"retention_days" minimum:"0" doc:"How many days audit events are kept (the install's audit.retention); older ones are deleted daily. 0 means they are kept forever."`
	}
}

// AuditAction is an action audit events can be filtered by.
type AuditAction struct {
	Action string `json:"action" doc:"The event kind (api_key.created)."`
	Label  string `json:"label" doc:"Its display name (API key created)."`
}

// ListAuditActionsOutput is the response of GET .../audit-events/actions.
type ListAuditActionsOutput struct {
	Body struct {
		Actions []AuditAction `json:"actions" doc:"In catalogue order."`
	}
}

// AuditEvents serves the audit event listings.
type AuditEvents struct {
	svc    AuditService
	authz  ProjectAuthorizer
	guard  *authz.Guard
	logger *slog.Logger
	// retentionDays is reported with every listing (WithRetention).
	retentionDays int
}

// NewAuditEvents returns the audit event endpoints over svc. guard (nil
// refuses the org operations with authz_unavailable) authorizes the
// organization operations, projects the project ones.
func NewAuditEvents(svc AuditService, projects ProjectAuthorizer, guard *authz.Guard, logger *slog.Logger) *AuditEvents {
	return &AuditEvents{svc: svc, authz: projects, guard: guard, logger: logger}
}

// WithRetention sets the audit.retention days the listings report (0 means
// kept forever).
func (a *AuditEvents) WithRetention(days int) *AuditEvents {
	a.retentionDays = days
	return a
}

const auditFilters = "Filters: `actor`, `action` (exact, or a prefix ending with a dot such as `api_key.`), `target_type`, `from`/`to` and `q` (target label). " +
	"Newest first, with cursor pagination (50 per page by default, at most 200)."

// Register mounts the audit event operations.
func (a *AuditEvents) Register(api huma.API) {
	session := []map[string][]string{{authn.SchemeSession: {}}}
	projectCodes := []identity.ErrCode{identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal}
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-project-audit-events",
		Method:      http.MethodGet,
		Path:        ProjectAuditEventsPath,
		Summary:     "List a project's audit events",
		Description: "Lists the project's audit trail: who did what, when, from where, and what changed. " + auditFilters +
			" Needs `view_audit` on the project (project admins, org owners and admins): 403 `forbidden` for editors and viewers, 404 `not_found` for a project the caller cannot view.",
		Tags:     []string{server.TagProjects},
		Security: session,
	}, projectCodes...), a.listProject)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-project-audit-actions",
		Method:      http.MethodGet,
		Path:        ProjectAuditActionsPath,
		Summary:     "List the actions a project's audit events can be filtered by",
		Description: "Lists the audit event actions with display labels, for the action filter. Needs `view_audit` on the project, like the event list.",
		Tags:        []string{server.TagProjects},
		Security:    session,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), a.projectActions)

	guard := huma.Middlewares{a.guard.RequireOrg(api, authz.OrgManage)}
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-org-audit-events",
		Method:      http.MethodGet,
		Path:        OrgAuditEventsPath,
		Summary:     "List an organization's audit events",
		Description: "Lists the organization's audit trail: its org-wide events and those of the projects the caller can view (never another project's); " +
			"each project event names its project. " + auditFilters +
			" Org owners and admins only (403 `forbidden` otherwise, 404 `not_found` for an organization the caller cannot view).",
		Tags:        []string{server.TagOrganizations},
		Security:    session,
		Middlewares: guard,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), a.listOrg)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-org-audit-actions",
		Method:      http.MethodGet,
		Path:        OrgAuditActionsPath,
		Summary:     "List the actions an organization's audit events can be filtered by",
		Description: "Lists the audit event actions with display labels, for the action filter. Org owners and admins only, like the event list.",
		Tags:        []string{server.TagOrganizations},
		Security:    session,
		Middlewares: guard,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), a.orgActions)
}

// authorizeProject checks view_audit on the project slug names.
func (a *AuditEvents) authorizeProject(ctx context.Context, slug string) (uuid.UUID, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return uuid.Nil, identity.Err(identity.CodeUnauthenticated)
	}
	if a.authz == nil {
		return uuid.Nil, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	}
	t, err := a.authz.AuthorizeProject(ctx, p, slug, authz.ProjectViewAudit)
	switch {
	case err == nil:
		return t.ProjectID, nil
	case errors.Is(err, authz.ErrNoResource):
		return uuid.Nil, identity.Err(identity.CodeNotFound)
	case errors.Is(err, authz.ErrForbidden):
		return uuid.Nil, identity.Err(identity.CodeForbidden)
	case errors.Is(err, authz.ErrUnavailable):
		return uuid.Nil, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	default:
		a.logger.ErrorContext(ctx, "authorize project audit events", "error", err)
		return uuid.Nil, identity.Err(identity.CodeInternal)
	}
}

func (a *AuditEvents) listProject(ctx context.Context, in *ListProjectAuditEventsInput) (*ListAuditEventsOutput, error) {
	pid, err := a.authorizeProject(ctx, in.Slug)
	if err != nil {
		return nil, err
	}
	q, err := in.query()
	if err != nil {
		return nil, err
	}
	page, err := a.svc.ListProject(ctx, pid, q)
	if err != nil {
		return nil, a.problem(ctx, "list project audit events", err)
	}
	return a.output(page), nil
}

func (a *AuditEvents) listOrg(ctx context.Context, in *ListOrgAuditEventsInput) (*ListAuditEventsOutput, error) {
	p, ok := authn.FromContext(ctx)
	t, tok := authz.TargetFromContext(ctx)
	if !ok || p.Kind != authn.KindUser || !tok {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	q, err := in.query()
	if err != nil {
		return nil, err
	}
	page, err := a.svc.ListOrg(ctx, p.UserID, t.OrgID, q)
	if err != nil {
		return nil, a.problem(ctx, "list org audit events", err)
	}
	return a.output(page), nil
}

func (a *AuditEvents) projectActions(ctx context.Context, in *ProjectSlugInput) (*ListAuditActionsOutput, error) {
	if _, err := a.authorizeProject(ctx, in.Slug); err != nil {
		return nil, err
	}
	return auditActions(), nil
}

func (a *AuditEvents) orgActions(_ context.Context, _ *OrgSlugInput) (*ListAuditActionsOutput, error) {
	return auditActions(), nil
}

func auditActions() *ListAuditActionsOutput {
	out := &ListAuditActionsOutput{}
	actions := audit.Actions()
	out.Body.Actions = make([]AuditAction, 0, len(actions))
	for _, x := range actions {
		out.Body.Actions = append(out.Body.Actions, AuditAction{Action: string(x.Kind), Label: x.Label})
	}
	return out
}

// query validates the filters into an audit.Query.
func (in *ListAuditEventsQuery) query() (audit.Query, error) {
	invalid := func(detail string) error {
		pr := identity.Err(identity.CodeInvalidRequest)
		pr.Detail = detail
		return pr
	}
	q := audit.Query{Action: in.Action, TargetType: in.TargetType, Q: in.Q, Limit: in.Limit, Cursor: in.Cursor}
	if in.Actor != "" {
		id, err := uuid.Parse(in.Actor)
		if err != nil {
			return q, invalid("actor must be a user id.")
		}
		q.Actor = &id
	}
	for _, x := range []struct {
		name string
		in   string
		out  **time.Time
	}{{"from", in.From, &q.From}, {"to", in.To, &q.To}} {
		if x.in == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, x.in)
		if err != nil {
			return q, invalid(x.name + " must be an RFC 3339 date-time.")
		}
		*x.out = &t
	}
	return q, nil
}

func (a *AuditEvents) problem(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, audit.ErrInvalidCursor):
		pr := identity.Err(identity.CodeInvalidRequest)
		pr.Detail = "Invalid cursor; pass next_cursor of the previous page."
		return pr
	case errors.Is(err, authz.ErrUnavailable):
		return identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	default:
		a.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func (a *AuditEvents) output(page auditlog.Page) *ListAuditEventsOutput {
	out := &ListAuditEventsOutput{}
	out.Body.NextCursor = page.NextCursor
	out.Body.RetentionDays = a.retentionDays
	out.Body.Events = make([]AuditEvent, 0, len(page.Entries))
	for _, e := range page.Entries {
		ev := AuditEvent{
			ID: strconv.FormatInt(e.ID, 10), Time: e.Time.UTC(), Action: e.Kind,
			Actor: AuditActor{Type: "system", Label: "System"},
			IP:    e.IP, UserAgent: e.UserAgent, RequestID: e.RequestID,
		}
		if e.Actor != nil {
			ev.Actor = AuditActor{Type: "user", ID: e.Actor.String(), Label: e.ActorLabel}
		}
		if e.Target.Type != "" || e.Target.ID != "" {
			ev.Target = &AuditTarget{Type: e.Target.Type, ID: e.Target.ID, Label: e.Target.Label}
		}
		if e.ProjectRef != nil {
			ev.Project = &AuditProject{Slug: e.ProjectRef.Slug, Name: e.ProjectRef.Name}
		}
		if len(e.Changes) > 0 {
			var c map[string]any
			if err := json.Unmarshal(e.Changes, &c); err == nil {
				ev.Changes = c
			}
		}
		out.Body.Events = append(out.Body.Events, ev)
	}
	return out
}
