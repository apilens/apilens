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
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the project endpoints.
const (
	OrgProjectsPath          = OrgPath + "/projects"
	ProjectsPath             = server.APIPrefix + "/projects"
	ProjectSlugAvailablePath = ProjectsPath + "/slug-available"
	ProjectPath              = ProjectsPath + "/{slug}"
	EnvironmentsPath         = ProjectPath + "/environments"
	EnvironmentPath          = EnvironmentsPath + "/{name}"
)

// ProjectService creates, reads, updates and deletes projects and their
// environments and checks slugs; *projects.Service satisfies it.
type ProjectService interface {
	Create(ctx context.Context, user uuid.UUID, orgSlug, name, slug string, envs []string) (projects.Project, error)
	Available(ctx context.Context, slug string) (bool, []string, error)
	List(ctx context.Context, user uuid.UUID, orgSlug string) ([]projects.Project, error)
	Get(ctx context.Context, id uuid.UUID) (projects.Project, error)
	Update(ctx context.Context, user, id uuid.UUID, u projects.Update) (projects.Project, error)
	Delete(ctx context.Context, id uuid.UUID) error
	AddEnvironment(ctx context.Context, user, id uuid.UUID, name string) (projects.Project, error)
	RemoveEnvironment(ctx context.Context, user, id uuid.UUID, name string) (projects.Project, error)
}

// Project is a project as seen by a member of its organization.
type Project struct {
	ID           string    `json:"id" format:"uuid" doc:"The project's immutable identifier; unlike the slug it never changes."`
	Slug         string    `json:"slug"`
	Name         string    `json:"name"`
	Description  string    `json:"description" maxLength:"280" doc:"Short description; empty when the project has none."`
	OrgID        string    `json:"org_id" format:"uuid"`
	OrgSlug      string    `json:"org_slug"`
	Role         string    `json:"role" enum:"admin,editor,viewer" doc:"The signed-in user's effective project role: the highest of their organization role (owners and admins are admin), the project's default access and a direct grant."`
	Environments []string  `json:"environments" doc:"The project's environment names, sorted."`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at" doc:"When the name or description last changed; the creation time until then."`
	CreatedBy    *string   `json:"created_by" format:"uuid" nullable:"true" doc:"The id of the user who created the project; null when unknown (projects created before this was recorded, or a deleted user)."`
}

// ProjectOutput is the response of the single-project operations.
type ProjectOutput struct {
	Body Project
}

// ListProjectsOutput is the response of GET /api/v1/orgs/{slug}/projects.
type ListProjectsOutput struct {
	Body []Project
}

// CreateProjectInput is the request of POST /api/v1/orgs/{slug}/projects.
type CreateProjectInput struct {
	OrgSlugInput
	Body struct {
		Name         string   `json:"name" minLength:"1" maxLength:"100" doc:"Display name; surrounding spaces are trimmed."`
		Slug         string   `json:"slug" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"URL name, globally unique among projects (the SDKs send it): lower-case letters, digits and hyphens, starting with a letter or digit, at most 63 characters."`
		Environments []string `json:"environments,omitempty" maxItems:"20" doc:"Environment names to create (letters, digits, '.', '_' and '-', at most 64 characters); defaults to [\"production\"]. Duplicates are dropped."`
	}
}

// ProjectSlugInput names a project in the path.
type ProjectSlugInput struct {
	Slug string `path:"slug" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"The project's slug."`
}

// UpdateProjectInput is the request of PATCH /api/v1/projects/{slug}.
// Omitted fields are left unchanged.
type UpdateProjectInput struct {
	ProjectSlugInput
	Body struct {
		Name        *string `json:"name,omitempty" minLength:"1" maxLength:"100" doc:"Display name; surrounding spaces are trimmed."`
		Description *string `json:"description,omitempty" maxLength:"280" doc:"Short description, at most 280 characters; surrounding spaces are trimmed and an empty string clears it."`
		Slug        *string `json:"slug,omitempty" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"Must equal the current slug: slugs cannot be changed yet (slug_immutable)."`
	}
}

// AddEnvironmentInput is the request of POST
// /api/v1/projects/{slug}/environments.
type AddEnvironmentInput struct {
	ProjectSlugInput
	Body struct {
		Name string `json:"name" pattern:"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" doc:"Environment name: letters, digits, '.', '_' and '-', starting with a letter or digit, at most 64 characters."`
	}
}

// EnvironmentInput names a project environment in the path.
type EnvironmentInput struct {
	ProjectSlugInput
	Name string `path:"name" pattern:"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" doc:"The environment's name."`
}

// ProjectSlugAvailableInput is the request of GET
// /api/v1/projects/slug-available.
type ProjectSlugAvailableInput struct {
	Slug string `query:"slug" required:"true" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"The slug to check."`
}

// ProjectSlugAvailableOutput is the response of GET
// /api/v1/projects/slug-available.
type ProjectSlugAvailableOutput struct {
	Body struct {
		Available   bool     `json:"available" doc:"Whether a new project can use the slug."`
		Suggestions []string `json:"suggestions" maxItems:"3" doc:"Up to three free alternatives when the slug is not available; empty otherwise."`
	}
}

// Projects serves the project endpoints.
type Projects struct {
	svc ProjectService
	// guard authorizes every operation (nil refuses them with
	// authz_unavailable); roles answers the effective project role.
	guard     *authz.Guard
	roles     RoleChecker
	limiter   *ratelimit.Limiter
	slugCheck ratelimit.Rate
	logger    *slog.Logger
	// recentAuth is the sign-in age sensitive operations allow
	// (identity.sensitive_action_max_age); 0 means authz.DefaultRecentAuth.
	recentAuth time.Duration
}

// WithRecentAuth sets the sign-in age sensitive operations (delete) allow
// and returns p.
func (p *Projects) WithRecentAuth(maxAge time.Duration) *Projects {
	p.recentAuth = maxAge
	return p
}

// NewProjects returns the project endpoints over svc, authorized by guard,
// with the effective project role from roles. limiter enforces slugCheck per
// user on the slug availability check.
func NewProjects(svc ProjectService, guard *authz.Guard, roles RoleChecker, limiter *ratelimit.Limiter, slugCheck ratelimit.Rate, logger *slog.Logger) *Projects {
	return &Projects{svc: svc, guard: guard, roles: roles, limiter: limiter, slugCheck: slugCheck, logger: logger}
}

// Register mounts the project operations. They declare the session scheme,
// so authn.Middleware must be installed on api before.
func (p *Projects) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	tags := []string{server.TagProjects}
	hiddenOrg := "An organization that does not exist or the user is not a member of answers `not_found` (404), so the cases cannot be told apart; `authz_unavailable` (503) when permissions cannot be checked."
	hidden := "A project that does not exist or the user cannot view answers `not_found` (404), so the cases cannot be told apart; `authz_unavailable` (503) when permissions cannot be checked."
	view := "Needs `view` on the project (any project role). "
	edit := "Needs `edit` on the project (project admins and editors; 403 `forbidden` for viewers). "
	recentAuth := "Needs a sign-in less than `identity.sensitive_action_max_age` (10 minutes) old: an older session answers `reauth_required` (403) and the user signs in again. "

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "create-project",
		Method:        http.MethodPost,
		Path:          OrgProjectsPath,
		DefaultStatus: http.StatusCreated,
		Summary:       "Create a project",
		Description: "Creates a project with its environments in the organization. Needs `create_project` on the organization (owners, admins and members; 403 `forbidden` for viewers). Project slugs are globally unique: a reserved or used slug answers `slug_taken` (409) with up to three free `suggestions`. " +
			"Emits `project.created`. " + hiddenOrg,
		Tags:        tags,
		Security:    security,
		Middlewares: huma.Middlewares{p.guard.RequireOrg(api, authz.OrgCreateProject)},
	}, identity.CodeInvalidRequest, identity.CodeSlugTaken, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.create)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-projects",
		Method:      http.MethodGet,
		Path:        OrgProjectsPath,
		Summary:     "List an organization's projects",
		Description: "Lists the organization's active projects the user can view, with their environments and the user's effective project role, ordered by name. " +
			"A restricted project (default access `none`) is listed only to organization owners and admins and to people added to it. " + hiddenOrg,
		Tags:        tags,
		Security:    security,
		Middlewares: huma.Middlewares{p.guard.RequireOrg(api, authz.OrgView)},
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.list)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "check-project-slug",
		Method:      http.MethodGet,
		Path:        ProjectSlugAvailablePath,
		Summary:     "Check whether a project slug is free",
		Description: "Answers whether a new project can use `slug` (project slugs are globally unique) and, when it cannot (taken or reserved), up to three free alternatives. Rate-limited per user.",
		Tags:        tags,
		Security:    security,
		Middlewares: huma.Middlewares{p.limiter.Limit(api, "project_slug_check", ratelimit.Rate{}, ratelimit.Key{Rate: p.slugCheck, From: userKey})},
	}, identity.CodeUnauthenticated, identity.CodeRateLimited, identity.CodeInternal), p.slugAvailable)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-project-by-slug",
		Method:      http.MethodGet,
		Path:        ProjectPath,
		Summary:     "Get a project",
		Description: "Returns the project, its environments and the signed-in user's effective project role. " + view + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.get)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "update-project",
		Method:      http.MethodPatch,
		Path:        ProjectPath,
		Summary:     "Update a project",
		Description: "Changes the project's name and description. An empty name or a description over 280 characters answers `invalid_request`; a slug other than the current one answers `slug_immutable`. A change moves `updated_at` and emits the `project.updated` audit event with the previous and next values. " + edit + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeSlugImmutable, identity.CodeAuthzUnavailable, identity.CodeInternal), p.update)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "delete-project",
		Method:        http.MethodDelete,
		Path:          ProjectPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Delete a project",
		Description:   "Soft-deletes the project; its slug becomes free. Needs `delete` on the project (project admins, organization owners and admins; 403 `forbidden` for editors and viewers). Emits `project.deleted`. " + recentAuth + hidden,
		Tags:          tags,
		Security:      security,
		Middlewares:   huma.Middlewares{authz.RequireRecentAuth(api, p.recentAuth)},
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeReauthRequired, identity.CodeAuthzUnavailable, identity.CodeInternal), p.delete)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "add-project-environment",
		Method:      http.MethodPost,
		Path:        EnvironmentsPath,
		Summary:     "Add an environment",
		Description: "Adds an environment to the project and returns the project; adding one it already has changes nothing. At most 20 environments per project (`invalid_request`). " + edit + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.addEnvironment)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "remove-project-environment",
		Method:      http.MethodDelete,
		Path:        EnvironmentPath,
		Summary:     "Remove an environment",
		Description: "Removes an environment from the project and returns the project; removing one it does not have changes nothing. Telemetry already recorded for it is kept. " + edit + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.removeEnvironment)
}

func toProject(pr projects.Project) Project {
	envs := pr.Environments
	if envs == nil {
		envs = []string{}
	}
	var createdBy *string
	if pr.CreatedBy != nil {
		id := pr.CreatedBy.String()
		createdBy = &id
	}
	return Project{
		ID:           pr.ID.String(),
		Slug:         pr.Slug,
		Name:         pr.Name,
		Description:  pr.Description,
		OrgID:        pr.OrgID.String(),
		OrgSlug:      pr.OrgSlug,
		Role:         pr.Role,
		Environments: envs,
		CreatedAt:    pr.CreatedAt.UTC(),
		UpdatedAt:    pr.UpdatedAt.UTC(),
		CreatedBy:    createdBy,
	}
}

// problem maps an error of projects.Service to a problem.
func (p *Projects) problem(ctx context.Context, op string, err error) error {
	var taken *projects.SlugTakenError
	switch {
	case errors.As(err, &taken):
		return identity.ErrSlugTaken(taken.Suggestions)
	case errors.Is(err, projects.ErrNotFound):
		return identity.Err(identity.CodeNotFound)
	case errors.Is(err, projects.ErrSlugImmutable):
		return identity.Err(identity.CodeSlugImmutable)
	case errors.Is(err, projects.ErrInvalid), errors.Is(err, projects.ErrTooManyEnvironments):
		return identity.Err(identity.CodeInvalidRequest)
	default:
		p.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func (p *Projects) create(ctx context.Context, in *CreateProjectInput) (*ProjectOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	// The creator's role comes from their organization role: SpiceDB learns
	// about the project through the outbox, after this request.
	pr, err := p.svc.Create(ctx, uid, in.Slug, in.Body.Name, in.Body.Slug, in.Body.Environments)
	if err != nil {
		return nil, p.problem(ctx, "create project", err)
	}
	return &ProjectOutput{Body: toProject(pr)}, nil
}

func (p *Projects) list(ctx context.Context, in *OrgSlugInput) (*ListProjectsOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	list, err := p.svc.List(ctx, uid, in.Slug)
	if err != nil {
		return nil, p.problem(ctx, "list projects", err)
	}
	roles, err := projectRoles(ctx, p.roles, uid, list)
	if err != nil {
		return nil, rolesProblem(ctx, p.logger, err)
	}
	out := &ListProjectsOutput{Body: make([]Project, 0, len(list))}
	for i, pr := range list {
		if roles[i] == "" {
			continue // a restricted project the user is not on
		}
		pr.Role = roles[i]
		out.Body = append(out.Body, toProject(pr))
	}
	return out, nil
}

// project authorizes permission on the project slug, runs fn on its id and
// the signed-in user's id and returns the project fn returns with the user's
// effective role.
func (p *Projects) project(ctx context.Context, op, slug string, permission authz.Permission,
	fn func(id, user uuid.UUID) (projects.Project, error),
) (*ProjectOutput, error) {
	t, uid, err := authorizeProject(ctx, p.guard, p.logger, slug, permission)
	if err != nil {
		return nil, err
	}
	pr, err := fn(t.ProjectID, uid)
	if err != nil {
		return nil, p.problem(ctx, op, err)
	}
	roles, err := projectRoles(ctx, p.roles, uid, []projects.Project{pr})
	if err != nil {
		return nil, rolesProblem(ctx, p.logger, err)
	}
	if roles[0] == "" {
		// Access was removed since the check.
		return nil, identity.Err(identity.CodeNotFound)
	}
	pr.Role = roles[0]
	return &ProjectOutput{Body: toProject(pr)}, nil
}

func (p *Projects) get(ctx context.Context, in *ProjectSlugInput) (*ProjectOutput, error) {
	return p.project(ctx, "get project", in.Slug, authz.ProjectView, func(id, _ uuid.UUID) (projects.Project, error) {
		return p.svc.Get(ctx, id)
	})
}

func (p *Projects) update(ctx context.Context, in *UpdateProjectInput) (*ProjectOutput, error) {
	return p.project(ctx, "update project", in.Slug, authz.ProjectEdit, func(id, user uuid.UUID) (projects.Project, error) {
		return p.svc.Update(ctx, user, id, projects.Update{Name: in.Body.Name, Description: in.Body.Description, Slug: in.Body.Slug})
	})
}

func (p *Projects) delete(ctx context.Context, in *ProjectSlugInput) (*struct{}, error) {
	t, _, err := authorizeProject(ctx, p.guard, p.logger, in.Slug, authz.ProjectDelete)
	if err != nil {
		return nil, err
	}
	if err := p.svc.Delete(ctx, t.ProjectID); err != nil {
		return nil, p.problem(ctx, "delete project", err)
	}
	return nil, nil
}

func (p *Projects) addEnvironment(ctx context.Context, in *AddEnvironmentInput) (*ProjectOutput, error) {
	return p.project(ctx, "add environment", in.Slug, authz.ProjectEdit, func(id, user uuid.UUID) (projects.Project, error) {
		return p.svc.AddEnvironment(ctx, user, id, in.Body.Name)
	})
}

func (p *Projects) removeEnvironment(ctx context.Context, in *EnvironmentInput) (*ProjectOutput, error) {
	return p.project(ctx, "remove environment", in.Slug, authz.ProjectEdit, func(id, user uuid.UUID) (projects.Project, error) {
		return p.svc.RemoveEnvironment(ctx, user, id, in.Name)
	})
}

func (p *Projects) slugAvailable(ctx context.Context, in *ProjectSlugAvailableInput) (*ProjectSlugAvailableOutput, error) {
	if _, err := signedInUser(ctx); err != nil {
		return nil, err
	}
	available, suggestions, err := p.svc.Available(ctx, in.Slug)
	if err != nil {
		p.logger.ErrorContext(ctx, "check project slug", "error", err)
		return nil, identity.Err(identity.CodeInternal)
	}
	out := &ProjectSlugAvailableOutput{}
	out.Body.Available = available
	out.Body.Suggestions = suggestions
	if out.Body.Suggestions == nil {
		out.Body.Suggestions = []string{}
	}
	return out, nil
}
