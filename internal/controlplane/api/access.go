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

// ProjectAccessPath lists who has access to a project and why.
const ProjectAccessPath = ProjectPath + "/access"

// AccessService reads project access; *access.Service satisfies it.
type AccessService interface {
	List(ctx context.Context, project uuid.UUID, f access.Filter) (access.Page, error)
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

// Access serves the project access endpoints.
type Access struct {
	svc    AccessService
	authz  ProjectAuthorizer
	logger *slog.Logger
}

// NewAccess returns the project access endpoints over svc.
func NewAccess(svc AccessService, guard ProjectAuthorizer, logger *slog.Logger) *Access {
	return &Access{svc: svc, authz: guard, logger: logger}
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
