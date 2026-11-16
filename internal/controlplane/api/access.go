package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/access"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the project access endpoints.
const (
	// ProjectAccessPath lists who has access to a project and why, and
	// sets its default access.
	ProjectAccessPath = ProjectPath + "/access"
	// ProjectMemberPath grants, changes or removes a direct project role.
	ProjectMemberPath = ProjectPath + "/members/{user_id}"
)

// AccessService reads and manages project access; *access.Service
// satisfies it.
type AccessService interface {
	List(ctx context.Context, project uuid.UUID, f access.Filter) (access.Page, error)
	Grant(ctx context.Context, actor, project, target uuid.UUID, role string) (access.Person, error)
	Revoke(ctx context.Context, actor, project, target uuid.UUID) (bool, error)
	SetDefault(ctx context.Context, actor, project uuid.UUID, def string, dryRun bool) (access.DefaultChange, error)
}

// AccessSource is one reason a person has a role on the project.
type AccessSource struct {
	Kind    string `json:"kind" enum:"org_role,default,direct" doc:"org_role: the organization role (owners and admins are admin on every project); default: the project's default access for org members; direct: added to the project directly."`
	Role    string `json:"role" enum:"admin,editor,viewer" doc:"The project role this source grants."`
	OrgRole string `json:"org_role,omitempty" enum:"owner,admin,member,viewer" doc:"The organization role the grant comes from; absent for direct."`
}

// AccessAddedBy is the user who added a direct grant.
type AccessAddedBy struct {
	ID   string `json:"id" format:"uuid"`
	Name string `json:"name" doc:"The user's name, or their email when they have not set one."`
}

// AccessMember is an org member who can view the project.
type AccessMember struct {
	UserID         string         `json:"user_id" format:"uuid"`
	Name           string         `json:"name"`
	Email          string         `json:"email" format:"email"`
	AvatarInitials string         `json:"avatar_initials" doc:"Initials of the name, or of the email's local part when no name is set."`
	EffectiveRole  string         `json:"effective_role" enum:"admin,editor,viewer" doc:"The highest role any source grants."`
	Sources        []AccessSource `json:"sources" doc:"Every source of access, in the order org_role, default, direct."`
	DirectRole     *string        `json:"direct_role" required:"true" nullable:"true" enum:"admin,editor,viewer" doc:"The role granted directly on the project; null without a direct grant."`
	AddedBy        *AccessAddedBy `json:"added_by,omitempty" doc:"Who granted the direct role; absent without one, or once their account is deleted."`
	AddedAt        time.Time      `json:"added_at" doc:"When the direct role was granted, or when the person joined the organization without one."`
	LastActiveAt   *time.Time     `json:"last_active_at" required:"true" nullable:"true" doc:"When the person last signed in; null if never."`
}

// ListProjectAccessInput is the request of GET /api/v1/projects/{slug}/access.
type ListProjectAccessInput struct {
	ProjectSlugInput
	Q      string `query:"q" maxLength:"200" doc:"Only people whose name or email contains this text (case-insensitive)."`
	Role   string `query:"role" enum:"admin,editor,viewer" doc:"Only people with this effective role."`
	Source string `query:"source" enum:"org_role,default,direct" doc:"Only people with a source of this kind."`
	Limit  int    `query:"limit" minimum:"1" maximum:"200" default:"50"`
	Cursor string `query:"cursor" maxLength:"512" doc:"next_cursor of the previous page; omitted means the first page."`
}

// ListProjectAccessOutput is the response of GET /api/v1/projects/{slug}/access.
type ListProjectAccessOutput struct {
	Body struct {
		DefaultAccess string         `json:"default_access" enum:"org_role,viewer,none" doc:"What org members get without a direct grant: org_role (members edit, viewers view), viewer (everyone views), none (only org owners and admins and people added directly)."`
		Members       []AccessMember `json:"members" doc:"By email."`
		NextCursor    string         `json:"next_cursor" doc:"Pass as cursor for the next page; empty on the last page."`
	}
}

// ProjectMemberInput names a person in the path of a project access write.
type ProjectMemberInput struct {
	ProjectSlugInput
	UserID string `path:"user_id" format:"uuid" doc:"The person's user id; they must be a member of the project's organization."`
}

// SetProjectRoleInput is the request of PUT
// /api/v1/projects/{slug}/members/{user_id}.
type SetProjectRoleInput struct {
	ProjectMemberInput
	Body struct {
		Role string `json:"role" enum:"admin,editor,viewer" doc:"The direct project role."`
	}
}

// SetProjectRoleOutput is the response of PUT
// /api/v1/projects/{slug}/members/{user_id}.
type SetProjectRoleOutput struct {
	Body AccessMember
}

// SetDefaultAccessInput is the request of PATCH
// /api/v1/projects/{slug}/access.
type SetDefaultAccessInput struct {
	ProjectSlugInput
	DryRun bool `query:"dry_run" doc:"Only report how many people would lose access; change nothing."`
	Body   struct {
		DefaultAccess string `json:"default_access" enum:"org_role,viewer,none" doc:"What org members get without a direct grant: org_role (members edit, viewers view), viewer (everyone views), none (only org owners and admins and people added directly)."`
	}
}

// SetDefaultAccessOutput is the response of PATCH
// /api/v1/projects/{slug}/access.
type SetDefaultAccessOutput struct {
	Body struct {
		DefaultAccess         string `json:"default_access" enum:"org_role,viewer,none" doc:"The default access now; unchanged on a dry run."`
		PreviousDefaultAccess string `json:"previous_default_access" enum:"org_role,viewer,none" doc:"The default access before the request."`
		LoseAccess            int64  `json:"lose_access" doc:"How many people lose (or, on a dry run, would lose) access: org members and viewers without a direct grant when the default becomes none; 0 otherwise."`
		DryRun                bool   `json:"dry_run" doc:"True when nothing was changed."`
	}
}

// Access serves the project access endpoints.
type Access struct {
	svc    AccessService
	authz  ProjectAuthorizer
	logger *slog.Logger
	// recentAuth is the sign-in age the access writes allow
	// (identity.sensitive_action_max_age); 0 means authz.DefaultRecentAuth.
	recentAuth time.Duration
	now        func() time.Time
}

// NewAccess returns the project access endpoints over svc.
func NewAccess(svc AccessService, guard ProjectAuthorizer, logger *slog.Logger) *Access {
	return &Access{svc: svc, authz: guard, logger: logger, now: time.Now}
}

// WithRecentAuth sets the sign-in age the access writes allow and returns a.
func (a *Access) WithRecentAuth(maxAge time.Duration) *Access {
	a.recentAuth = maxAge
	return a
}

// Register mounts the project access operations.
func (a *Access) Register(api huma.API) {
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-project-access",
		Method:      http.MethodGet,
		Path:        ProjectAccessPath,
		Summary:     "List who has access to a project",
		Description: "Lists every org member who can view the project with their effective role (the highest of their organization role, the project's default access and a direct grant) " +
			"and each source of it, by email, with cursor pagination. On a project whose default access is `none`, org members without a direct grant are not listed. " +
			"Needs `view` on the project (any member who can see it); a project the caller cannot view answers 404 `not_found`.",
		Tags:     []string{server.TagProjects},
		Security: []map[string][]string{{authn.SchemeSession: {}}},
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), a.list)

	security := []map[string][]string{{authn.SchemeSession: {}}}
	manage := "Needs `manage_access` on the project (project admins: org owners and admins and people granted admin): a project the caller cannot view answers 404 `not_found`, a viewer or editor 403 `forbidden`. " +
		"Needs a sign-in less than `identity.sensitive_action_max_age` (10 minutes) old: an older session answers `reauth_required` (403) and the user signs in again. " +
		"The relationship change is written to the outbox in the same transaction, like membership changes, so the next permission check sees it."

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "set-project-member-role",
		Method:      http.MethodPut,
		Path:        ProjectMemberPath,
		Summary:     "Grant or change a project role",
		Description: "Gives the person a direct role on the project, or changes it. The person must be a member of the project's organization (`not_org_member` otherwise; invite them first). " +
			"A role lower than what they already have through the organization or the default access is allowed: the response is their access afterwards, with the effective role (the highest of every source). " +
			"A project holds at most `access.max_direct_members_per_project` (default 500) direct grants: one more answers `member_limit_reached` (409). " +
			"Emits `project_member.upserted`; audited as `project_member.added` or `project_member.role_changed`. " + manage,
		Tags:     []string{server.TagProjects},
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeReauthRequired, identity.CodeNotFound,
		identity.CodeNotOrgMember, identity.CodeMemberLimitReached, identity.CodeAuthzUnavailable, identity.CodeInternal), a.setRole)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "remove-project-member",
		Method:        http.MethodDelete,
		Path:          ProjectMemberPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Remove a project role",
		Description: "Removes the person's direct role on the project; they keep what their organization role and the default access give them. A caller may remove their own grant. " +
			"Removing a grant that does not exist answers 204. The person must be a member of the project's organization (`not_org_member` otherwise). " +
			"Emits `project_member.deleted`; audited as `project_member.removed`. " + manage,
		Tags:     []string{server.TagProjects},
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeReauthRequired, identity.CodeNotFound,
		identity.CodeNotOrgMember, identity.CodeAuthzUnavailable, identity.CodeInternal), a.removeRole)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "set-project-default-access",
		Method:      http.MethodPatch,
		Path:        ProjectAccessPath,
		Summary:     "Set a project's default access",
		Description: "Sets what org members get on the project without a direct grant: `org_role` (members edit, viewers view), `viewer` (everyone views) or `none` (only org owners and admins and people added directly). " +
			"`lose_access` says how many people lose access (members and viewers without a direct grant when the default becomes `none`); with `dry_run=true` nothing changes, so the UI can confirm first. " +
			"Emits `project.access_changed`, audited as `project.access_changed`, and emails the project admins. " + manage,
		Tags:     []string{server.TagProjects},
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeReauthRequired, identity.CodeNotFound,
		identity.CodeAuthzUnavailable, identity.CodeInternal), a.setDefault)
}

func (a *Access) authorize(ctx context.Context, slug string, permission authz.Permission) (uuid.UUID, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return uuid.Nil, identity.Err(identity.CodeUnauthenticated)
	}
	if a.authz == nil {
		return uuid.Nil, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	}
	t, err := a.authz.AuthorizeProject(ctx, p, slug, permission)
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
		a.logger.ErrorContext(ctx, "authorize project access", "error", err)
		return uuid.Nil, identity.Err(identity.CodeInternal)
	}
}

// authorizeWrite authorizes an access write: manage_access on the project,
// then a recent sign-in. It returns the project and the caller.
func (a *Access) authorizeWrite(ctx context.Context, slug string) (uuid.UUID, uuid.UUID, error) {
	pid, err := a.authorize(ctx, slug, authz.ProjectManageAccess)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	p, _ := authn.FromContext(ctx)
	maxAge := a.recentAuth
	if maxAge <= 0 {
		maxAge = authz.DefaultRecentAuth
	}
	if !authz.RecentAuth(p, maxAge, a.now()) {
		return uuid.Nil, uuid.Nil, identity.Err(identity.CodeReauthRequired)
	}
	return pid, p.UserID, nil
}

// writeProblem maps an error of an access write to a problem.
func (a *Access) writeProblem(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, access.ErrInvalid):
		return identity.Err(identity.CodeInvalidRequest)
	case errors.Is(err, access.ErrNotFound):
		return identity.Err(identity.CodeNotFound)
	case errors.Is(err, access.ErrNotOrgMember):
		return identity.Err(identity.CodeNotOrgMember)
	case errors.Is(err, access.ErrMemberLimit):
		return identity.Err(identity.CodeMemberLimitReached)
	default:
		a.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func (a *Access) setRole(ctx context.Context, in *SetProjectRoleInput) (*SetProjectRoleOutput, error) {
	pid, actor, err := a.authorizeWrite(ctx, in.Slug)
	if err != nil {
		return nil, err
	}
	target, err := uuid.Parse(in.UserID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	p, err := a.svc.Grant(ctx, actor, pid, target, in.Body.Role)
	if err != nil {
		return nil, a.writeProblem(ctx, "set project role", err)
	}
	return &SetProjectRoleOutput{Body: toAccessMember(p)}, nil
}

func (a *Access) removeRole(ctx context.Context, in *ProjectMemberInput) (*struct{}, error) {
	pid, actor, err := a.authorizeWrite(ctx, in.Slug)
	if err != nil {
		return nil, err
	}
	target, err := uuid.Parse(in.UserID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	if _, err := a.svc.Revoke(ctx, actor, pid, target); err != nil {
		return nil, a.writeProblem(ctx, "remove project role", err)
	}
	return nil, nil
}

func (a *Access) setDefault(ctx context.Context, in *SetDefaultAccessInput) (*SetDefaultAccessOutput, error) {
	pid, actor, err := a.authorizeWrite(ctx, in.Slug)
	if err != nil {
		return nil, err
	}
	c, err := a.svc.SetDefault(ctx, actor, pid, in.Body.DefaultAccess, in.DryRun)
	if err != nil {
		return nil, a.writeProblem(ctx, "set default access", err)
	}
	out := &SetDefaultAccessOutput{}
	out.Body.DefaultAccess = c.Current
	out.Body.PreviousDefaultAccess = c.Previous
	out.Body.LoseAccess = c.LoseAccess
	out.Body.DryRun = c.DryRun
	return out, nil
}

func (a *Access) list(ctx context.Context, in *ListProjectAccessInput) (*ListProjectAccessOutput, error) {
	pid, err := a.authorize(ctx, in.Slug, authz.ProjectView)
	if err != nil {
		return nil, err
	}
	page, err := a.svc.List(ctx, pid, access.Filter{Q: in.Q, Role: in.Role, Source: in.Source, Limit: in.Limit, Cursor: in.Cursor})
	switch {
	case errors.Is(err, access.ErrInvalid):
		pr := identity.Err(identity.CodeInvalidRequest)
		pr.Detail = "Invalid cursor; pass next_cursor of the previous page."
		return nil, pr
	case errors.Is(err, access.ErrNotFound):
		return nil, identity.Err(identity.CodeNotFound)
	case err != nil:
		a.logger.ErrorContext(ctx, "list project access", "error", err)
		return nil, identity.Err(identity.CodeInternal)
	}
	out := &ListProjectAccessOutput{}
	out.Body.DefaultAccess = page.DefaultAccess
	out.Body.NextCursor = page.NextCursor
	out.Body.Members = make([]AccessMember, 0, len(page.People))
	for _, p := range page.People {
		out.Body.Members = append(out.Body.Members, toAccessMember(p))
	}
	return out, nil
}

func toAccessMember(p access.Person) AccessMember {
	sources := make([]AccessSource, 0, len(p.Sources))
	for _, s := range p.Sources {
		sources = append(sources, AccessSource{Kind: s.Kind, Role: s.Role, OrgRole: s.OrgRole})
	}
	var addedBy *AccessAddedBy
	if p.AddedBy != nil {
		addedBy = &AccessAddedBy{ID: p.AddedBy.ID.String(), Name: p.AddedBy.Name}
	}
	return AccessMember{
		UserID: p.UserID.String(), Name: p.Name, Email: p.Email, AvatarInitials: p.Initials,
		EffectiveRole: p.EffectiveRole, Sources: sources, DirectRole: p.DirectRole, AddedBy: addedBy,
		AddedAt: p.AddedAt.UTC(), LastActiveAt: utc(p.LastActiveAt),
	}
}
