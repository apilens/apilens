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
	EnvironmentOrderPath     = EnvironmentsPath + "/order"
	ProjectPausePath         = ProjectPath + "/pause"
	ProjectResumePath        = ProjectPath + "/resume"
	DeletedProjectsPath      = OrgProjectsPath + "/deleted"
	RestoreProjectPath       = OrgProjectsPath + "/{id}/restore"
	ProjectRenamePath        = ProjectPath + "/rename"
)

// ProjectService creates, reads, updates and deletes projects and their
// environments and checks slugs; *projects.Service satisfies it.
type ProjectService interface {
	Create(ctx context.Context, user uuid.UUID, orgSlug, name, slug string, envs []string) (projects.Project, error)
	Available(ctx context.Context, slug string) (bool, []string, error)
	List(ctx context.Context, user uuid.UUID, orgSlug string) ([]projects.Project, error)
	Get(ctx context.Context, id uuid.UUID) (projects.Project, error)
	Update(ctx context.Context, user, id uuid.UUID, u projects.Update) (projects.Project, error)
	Delete(ctx context.Context, user, id uuid.UUID, confirm string) (projects.Scheduled, error)
	ListDeleted(ctx context.Context, orgID uuid.UUID) ([]projects.Scheduled, error)
	Restore(ctx context.Context, user, orgID, id uuid.UUID) (projects.Project, error)
	Rename(ctx context.Context, user, id uuid.UUID, slug string) (projects.Project, error)
	AddEnvironment(ctx context.Context, user, id uuid.UUID, name string) (projects.Project, error)
	RemoveEnvironment(ctx context.Context, user, id uuid.UUID, name string) (projects.Project, error)
	ListEnvironments(ctx context.Context, id uuid.UUID) ([]projects.Environment, error)
	UpdateEnvironment(ctx context.Context, user, id uuid.UUID, name string, u projects.EnvironmentUpdate) (projects.Environment, error)
	ReorderEnvironments(ctx context.Context, user, id uuid.UUID, names []string) ([]projects.Environment, error)
	Pause(ctx context.Context, user, id uuid.UUID) (projects.Project, error)
	Resume(ctx context.Context, user, id uuid.UUID) (projects.Project, error)
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
	UpdatedAt    time.Time `json:"updated_at" doc:"When the name, description or repository link last changed; the creation time until then."`
	CreatedBy    *string   `json:"created_by" format:"uuid" nullable:"true" doc:"The id of the user who created the project; null when unknown (projects created before this was recorded, or a deleted user)."`
	// The source repository link and the URLs derived from it.
	RepositoryURL      *string `json:"repository_url" format:"uri" nullable:"true" doc:"The https URL of the project's source repository, e.g. https://github.com/acme/shop; null when none is set. A link only: no access to the repository."`
	CommitURLTemplate  *string `json:"commit_url_template" nullable:"true" doc:"URL of a commit in the repository with the placeholder {commit} for the URL-encoded commit id; null when no repository is set or its host's URL layout is not known (hosts other than github.com, gitlab.com and bitbucket.org)."`
	ReleaseURLTemplate *string `json:"release_url_template" nullable:"true" doc:"URL of a release in the repository with the placeholder {release} for the URL-encoded release name; null under the same conditions as commit_url_template."`
	// Ingest pause (POST .../pause and .../resume).
	PausedAt *time.Time `json:"paused_at" nullable:"true" doc:"When ingest was paused for the project: while set, the ingest edge answers 403 project_paused to every call made with the project's keys. Null while ingest is accepted."`
	PausedBy *string    `json:"paused_by" format:"uuid" nullable:"true" doc:"The id of the user who paused ingest; null when ingest is not paused or the user is deleted."`

	// CanonicalSlug is the slug clients redirect to (#794).
	CanonicalSlug string `json:"canonical_slug" doc:"The project's current slug, to redirect to: a request that named the project by a slug a rename retired still resolves, and answers this slug here and in the Content-Location header."`
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
		Slug        *string `json:"slug,omitempty" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"Must equal the current slug (slug_immutable): rename a project with POST /api/v1/projects/{slug}/rename."`
		// RepositoryURL is checked by projects.NormalizeRepositoryURL.
		RepositoryURL *string `json:"repository_url,omitempty" maxLength:"2048" doc:"The https URL of the project's source repository on github.com, gitlab.com or bitbucket.org (any https host when the install sets integrations.allow_any_repository_host), at most 2048 characters. Surrounding spaces, a trailing slash and a trailing .git are dropped; an empty string removes the link."`
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

// RenameProjectInput is the request of POST
// /api/v1/projects/{slug}/rename.
type RenameProjectInput struct {
	ProjectSlugInput
	Body struct {
		Slug string `json:"slug" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"The new slug, with the rules of create: lower-case letters, digits and hyphens, starting with a letter or digit, at most 63 characters, globally unique among projects."`
	}
}

// EnvironmentInput names a project environment in the path.
type EnvironmentInput struct {
	ProjectSlugInput
	Name string `path:"name" pattern:"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" doc:"The environment's name."`
}

// Environment is a project environment with its settings.
type Environment struct {
	Name         string     `json:"name"`
	IsProduction bool       `json:"is_production" doc:"Whether the environment serves real users. Environments named production or prod start as production."`
	Color        *string    `json:"color" required:"true" nullable:"true" doc:"One of the fixed palette gray, red, orange, yellow, green, teal, blue, purple; null when the environment has no colour."`
	Position     int        `json:"position" doc:"Index of the environment in the project's order, 0 first."`
	Hidden       bool       `json:"hidden" doc:"Hidden environments still ingest; environment pickers leave them out by default."`
	HiddenAt     *time.Time `json:"hidden_at" required:"true" nullable:"true" doc:"When the environment was hidden; null when visible."`
	Source       string     `json:"source" enum:"sdk,dashboard" doc:"sdk when ingest registered it from the data an SDK sent, dashboard when someone added it."`
	FirstSeenAt  *time.Time `json:"first_seen_at" required:"true" nullable:"true" doc:"When data for the environment was first seen; null if never."`
	LastSeenAt   *time.Time `json:"last_seen_at" required:"true" nullable:"true" doc:"When data for the environment was last seen; null if never."`
	CreatedAt    time.Time  `json:"created_at"`
	HasData      bool       `json:"has_data" doc:"Whether data for the environment was seen within the install's telemetry retention."`
	APIKeys      int        `json:"api_keys" doc:"Active API keys pinned to the environment."`
	HealthChecks int        `json:"health_checks" doc:"Health checks that use the environment."`
	Deletable    bool       `json:"deletable" doc:"Whether DELETE would remove the environment: false when it has data, an API key pinned to it or a health check using it (hide it instead)."`
}

// EnvironmentOutput is the response of PATCH
// /api/v1/projects/{slug}/environments/{name}.
type EnvironmentOutput struct {
	Body Environment
}

// EnvironmentsOutput is the response of GET
// /api/v1/projects/{slug}/environments and of PUT .../environments/order.
type EnvironmentsOutput struct {
	Body struct {
		Environments []Environment `json:"environments" doc:"The project's environments in order, hidden ones included."`
		Max          int           `json:"max_environments" doc:"How many environments a project may have."`
	}
}

// UpdateEnvironmentInput is the request of PATCH
// /api/v1/projects/{slug}/environments/{name}. Omitted fields are left
// unchanged.
type UpdateEnvironmentInput struct {
	EnvironmentInput
	Body struct {
		IsProduction *bool   `json:"is_production,omitempty" doc:"Mark or unmark the environment as production."`
		Color        *string `json:"color,omitempty" enum:"gray,red,orange,yellow,green,teal,blue,purple,none" doc:"A colour of the fixed palette; none clears it."`
		Hidden       *bool   `json:"hidden,omitempty" doc:"Hide or show the environment. Hidden environments still ingest."`
		Position     *int    `json:"position,omitempty" minimum:"0" doc:"Move the environment to this index of the project's order (past the end moves it last); the others keep their relative order."`
	}
}

// ReorderEnvironmentsInput is the request of PUT
// /api/v1/projects/{slug}/environments/order.
type ReorderEnvironmentsInput struct {
	ProjectSlugInput
	Body struct {
		Names []string `json:"names" maxItems:"20" doc:"Environment names in the new order; environments left out follow in their current order. An unknown or repeated name answers invalid_request."`
	}
}

// DeleteProjectInput is the request of DELETE /api/v1/projects/{slug}. The
// body is optional in the schema so the guard answers first (404/403); a
// missing body is a wrong confirmation.
type DeleteProjectInput struct {
	ProjectSlugInput
	Body *DeleteProjectBody
}

// DeleteProjectBody confirms a project delete.
type DeleteProjectBody struct {
	Confirm string `json:"confirm" maxLength:"63" doc:"The project's slug, typed by the user to confirm; anything else (or no body) answers confirmation_mismatch (422) and nothing changes."`
}

// DeletedProject is a deleted project waiting for its purge.
type DeletedProject struct {
	ID          string    `json:"id" format:"uuid"`
	Slug        string    `json:"slug" doc:"The project's slug; reserved until the purge."`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	DeletedAt   time.Time `json:"deleted_at"`
	PurgeAfter  time.Time `json:"purge_after" doc:"When the project and its data are removed for good; it can be restored until then."`
}

// DeletedProjectOutput is the response of DELETE /api/v1/projects/{slug}.
type DeletedProjectOutput struct {
	Body DeletedProject
}

// ListDeletedProjectsOutput is the response of GET
// /api/v1/orgs/{slug}/projects/deleted.
type ListDeletedProjectsOutput struct {
	Body []DeletedProject
}

// RestoreProjectInput is the request of POST
// /api/v1/orgs/{slug}/projects/{id}/restore.
type RestoreProjectInput struct {
	OrgSlugInput
	ID string `path:"id" format:"uuid" doc:"The deleted project's id."`
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

// WithRecentAuth sets the sign-in age sensitive operations (delete, rename) allow
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
		Description: "Answers whether a new project can use `slug` (project slugs are globally unique) and, when it cannot (taken, reserved, or retired by another project's rename less than 30 days ago), up to three free alternatives. Rate-limited per user.",
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
		Description: "Changes the project's name, description and source repository link. An empty name, a description over 280 characters or a repository link that is not https, names a host that is not allowed, carries credentials, a query or a fragment, or does not name a repository answers `invalid_request`; a slug other than the current one answers `slug_immutable`. A change moves `updated_at` and emits the `project.updated` audit event with the previous and next values. " + edit + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeSlugImmutable, identity.CodeAuthzUnavailable, identity.CodeInternal), p.update)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "delete-project",
		Method:      http.MethodDelete,
		Path:        ProjectPath,
		Summary:     "Delete a project",
		Description: "Deletes the project and schedules its purge after `project.deletion_grace` (7 days by default); returns when it will be purged. `confirm` must be the project's slug, else `confirmation_mismatch` (422) and nothing changes. " +
			"From that moment the project is gone from every project endpoint, nobody holds a permission on it, its API keys are refused by ingest with 403 `project_deleted`, and its slug stays reserved. " +
			"Organization owners and admins can restore it until `purge_after` (`POST /orgs/{slug}/projects/{id}/restore`). " +
			"Needs `delete` on the project (project admins, organization owners and admins; 403 `forbidden` for editors and viewers). Emits `project.deleted`; audited as `project.deleted` with the purge date. " + recentAuth + hidden,
		Tags:        tags,
		Security:    security,
		Middlewares: huma.Middlewares{authz.RequireRecentAuth(api, p.recentAuth)},
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeConfirmationMismatch, identity.CodeReauthRequired, identity.CodeAuthzUnavailable, identity.CodeInternal), p.delete)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-deleted-projects",
		Method:      http.MethodGet,
		Path:        DeletedProjectsPath,
		Summary:     "List an organization's deleted projects",
		Description: "Lists the organization's deleted projects that can still be restored, most recently deleted first, with when each will be purged. " +
			"Needs `manage` on the organization (owners and admins; 403 `forbidden` for members and viewers). " + hiddenOrg,
		Tags:        tags,
		Security:    security,
		Middlewares: huma.Middlewares{p.guard.RequireOrg(api, authz.OrgManage)},
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.listDeleted)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "restore-project",
		Method:      http.MethodPost,
		Path:        RestoreProjectPath,
		Summary:     "Restore a deleted project",
		Description: "Restores a deleted project of the organization before its purge and returns it: its access (default access and people added directly), API keys, apps, environments and slug are back exactly as before the delete. " +
			"A project that is not deleted, belongs to another organization or is past `purge_after` answers `not_found` (404). " +
			"Needs `manage` on the organization (owners and admins; 403 `forbidden` for members and viewers). Emits `project.restored`; audited as `project.restored`. " + recentAuth + hiddenOrg,
		Tags:        tags,
		Security:    security,
		Middlewares: huma.Middlewares{p.guard.RequireOrg(api, authz.OrgManage), authz.RequireRecentAuth(api, p.recentAuth)},
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeReauthRequired, identity.CodeAuthzUnavailable, identity.CodeInternal), p.restore)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "rename-project",
		Method:      http.MethodPost,
		Path:        ProjectRenamePath,
		Summary:     "Rename a project's slug",
		Description: "Changes the project's slug and returns the project. The new slug follows the rules of create: a reserved slug, one another project uses or one another project's rename retired less than 30 days ago answers `slug_taken` (409) with up to three free `suggestions`; the project may take back a slug it used before. " +
			"The old slug keeps leading to the project until another project takes it (every operation answers with the current slug in `Content-Location` and, on project responses, `canonical_slug`) and is reserved for the project for 30 days. Telemetry, keys and SDK setups are keyed by the project id: no data moves. Renaming to the current slug changes nothing. " +
			"Needs `delete` on the project (project admins, organization owners and admins; 403 `forbidden` for editors and viewers). Emits `project.slug_changed`. " + recentAuth + hidden,
		Tags:        tags,
		Security:    security,
		Middlewares: huma.Middlewares{authz.RequireRecentAuth(api, p.recentAuth)},
	}, identity.CodeInvalidRequest, identity.CodeSlugTaken, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeReauthRequired, identity.CodeAuthzUnavailable, identity.CodeInternal), p.rename)

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
		Description: "Removes an environment from the project and returns the project; removing one it does not have changes nothing. An environment with data within retention, an active API key pinned to it or a health check using it answers `environment_in_use` (409): hide it instead. " + edit + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeEnvironmentInUse, identity.CodeAuthzUnavailable, identity.CodeInternal), p.removeEnvironment)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-project-environments",
		Method:      http.MethodGet,
		Path:        EnvironmentsPath,
		Summary:     "List a project's environments",
		Description: "Returns the project's environments in order, hidden ones included, with their settings, when data was last seen, whether data exists within retention and what refers to them. " + view + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.listEnvironments)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "update-project-environment",
		Method:      http.MethodPatch,
		Path:        EnvironmentPath,
		Summary:     "Update an environment",
		Description: "Changes an environment's production flag, colour, hidden state or position and returns it. An environment the project does not have answers `not_found`. A change emits `environment.updated` with the previous and next values. " + edit + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.updateEnvironment)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "reorder-project-environments",
		Method:      http.MethodPut,
		Path:        EnvironmentOrderPath,
		Summary:     "Order a project's environments",
		Description: "Puts the named environments first, in the given order; the others follow in their current order. Returns the environments in their new order. Each environment that moves emits `environment.updated` with its previous and next position. " + edit + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.reorderEnvironments)

	danger := "Needs `delete` on the project (project admins, organization owners and admins; 403 `forbidden` for editors and viewers). "
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "pause-project-ingest",
		Method:      http.MethodPost,
		Path:        ProjectPausePath,
		Summary:     "Pause ingest for a project",
		Description: "Pauses ingest and returns the project with `paused_at` set. From then on the ingest edge answers 403 `project_paused` to every ingest call made with one of the project's keys (at once with Valkey, otherwise within the key cache TTL); the SDKs drop those batches without retrying. Stored data, the dashboard and the query API are unaffected. Pausing a paused project changes nothing. Emits the `project.paused` audit event. " + danger + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.pause)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "resume-project-ingest",
		Method:      http.MethodPost,
		Path:        ProjectResumePath,
		Summary:     "Resume ingest for a project",
		Description: "Resumes ingest for a paused project and returns it with `paused_at` null; the ingest edge accepts its keys again (at once with Valkey, otherwise within the key cache TTL). Resuming a project that is not paused changes nothing. Emits the `project.resumed` audit event. " + danger + hidden,
		Tags:        tags,
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), p.resume)
}

func toEnvironment(e projects.Environment) Environment {
	utc := func(t *time.Time) *time.Time {
		if t == nil {
			return nil
		}
		u := t.UTC()
		return &u
	}
	return Environment{
		Name: e.Name, IsProduction: e.IsProduction, Color: e.Color, Position: e.Position,
		Hidden: e.Hidden(), HiddenAt: utc(e.HiddenAt), Source: e.Source,
		FirstSeenAt: utc(e.FirstSeenAt), LastSeenAt: utc(e.LastSeenAt), CreatedAt: e.CreatedAt.UTC(),
		HasData: e.HasData, APIKeys: e.APIKeys, HealthChecks: e.HealthChecks, Deletable: !e.InUse(),
	}
}

func toEnvironments(envs []projects.Environment) *EnvironmentsOutput {
	out := &EnvironmentsOutput{}
	out.Body.Environments = make([]Environment, 0, len(envs))
	for _, e := range envs {
		out.Body.Environments = append(out.Body.Environments, toEnvironment(e))
	}
	out.Body.Max = projects.MaxEnvironments
	return out
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
	commit, release := projects.RepositoryTemplates(pr.RepositoryURL)
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

		RepositoryURL:      pr.RepositoryURL,
		CommitURLTemplate:  commit,
		ReleaseURLTemplate: release,

		PausedAt: utcPtr(pr.PausedAt),
		PausedBy: uuidPtr(pr.PausedBy),

		CanonicalSlug: pr.Slug,
	}
}

// utcPtr is t in UTC, or nil.
func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// uuidPtr is id as a string, or nil.
func uuidPtr(id *uuid.UUID) *string {
	if id == nil {
		return nil
	}
	s := id.String()
	return &s
}

// problem maps an error of projects.Service to a problem.
func (p *Projects) problem(ctx context.Context, op string, err error) error {
	var taken *projects.SlugTakenError
	var repo *projects.RepositoryURLError
	switch {
	case errors.As(err, &taken):
		return identity.ErrSlugTaken(taken.Suggestions)
	case errors.As(err, &repo):
		pr := identity.Err(identity.CodeInvalidRequest)
		pr.Detail = repo.Reason
		return pr
	case errors.Is(err, projects.ErrNotFound), errors.Is(err, projects.ErrEnvironmentNotFound):
		return identity.Err(identity.CodeNotFound)
	case errors.Is(err, projects.ErrEnvironmentInUse):
		return identity.Err(identity.CodeEnvironmentInUse)
	case errors.Is(err, projects.ErrSlugImmutable):
		return identity.Err(identity.CodeSlugImmutable)
	case errors.Is(err, projects.ErrConfirmMismatch):
		return identity.Err(identity.CodeConfirmationMismatch)
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
		return p.svc.Update(ctx, user, id, projects.Update{
			Name: in.Body.Name, Description: in.Body.Description, Slug: in.Body.Slug, RepositoryURL: in.Body.RepositoryURL,
		})
	})
}

func toDeletedProject(s projects.Scheduled) DeletedProject {
	return DeletedProject{
		ID: s.ID.String(), Slug: s.Slug, Name: s.Name, Description: s.Description,
		CreatedAt: s.CreatedAt.UTC(), DeletedAt: s.DeletedAt.UTC(), PurgeAfter: s.PurgeAfter.UTC(),
	}
}

func (p *Projects) delete(ctx context.Context, in *DeleteProjectInput) (*DeletedProjectOutput, error) {
	t, uid, err := authorizeProject(ctx, p.guard, p.logger, in.Slug, authz.ProjectDelete)
	if err != nil {
		return nil, err
	}
	confirm := ""
	if in.Body != nil {
		confirm = in.Body.Confirm
	}
	s, err := p.svc.Delete(ctx, uid, t.ProjectID, confirm)
	if err != nil {
		return nil, p.problem(ctx, "delete project", err)
	}
	return &DeletedProjectOutput{Body: toDeletedProject(s)}, nil
}

func (p *Projects) listDeleted(ctx context.Context, _ *OrgSlugInput) (*ListDeletedProjectsOutput, error) {
	t, ok := authz.TargetFromContext(ctx)
	if !ok {
		return nil, identity.Err(identity.CodeInternal)
	}
	list, err := p.svc.ListDeleted(ctx, t.OrgID)
	if err != nil {
		return nil, p.problem(ctx, "list deleted projects", err)
	}
	out := &ListDeletedProjectsOutput{Body: make([]DeletedProject, 0, len(list))}
	for _, s := range list {
		out.Body = append(out.Body, toDeletedProject(s))
	}
	return out, nil
}

func (p *Projects) restore(ctx context.Context, in *RestoreProjectInput) (*ProjectOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	t, ok := authz.TargetFromContext(ctx)
	if !ok {
		return nil, identity.Err(identity.CodeInternal)
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, identity.Err(identity.CodeNotFound)
	}
	pr, err := p.svc.Restore(ctx, uid, t.OrgID, id)
	if err != nil {
		return nil, p.problem(ctx, "restore project", err)
	}
	// manage on the organization (owners and admins) is admin on every
	// project; SpiceDB learns about the restore through the outbox, after
	// this request.
	pr.Role = projects.RoleAdmin
	return &ProjectOutput{Body: toProject(pr)}, nil
}

func (p *Projects) rename(ctx context.Context, in *RenameProjectInput) (*ProjectOutput, error) {
	out, err := p.project(ctx, "rename project", in.Slug, authz.ProjectDelete, func(id, user uuid.UUID) (projects.Project, error) {
		return p.svc.Rename(ctx, user, id, in.Body.Slug)
	})
	if err == nil {
		// Both slugs now resolve differently: the old one to the project
		// under its new canonical slug, the new one for the first time.
		p.guard.ForgetProject(in.Slug, in.Body.Slug)
	}
	return out, err
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

func (p *Projects) listEnvironments(ctx context.Context, in *ProjectSlugInput) (*EnvironmentsOutput, error) {
	t, _, err := authorizeProject(ctx, p.guard, p.logger, in.Slug, authz.ProjectView)
	if err != nil {
		return nil, err
	}
	envs, err := p.svc.ListEnvironments(ctx, t.ProjectID)
	if err != nil {
		return nil, p.problem(ctx, "list environments", err)
	}
	return toEnvironments(envs), nil
}

func (p *Projects) updateEnvironment(ctx context.Context, in *UpdateEnvironmentInput) (*EnvironmentOutput, error) {
	t, uid, err := authorizeProject(ctx, p.guard, p.logger, in.Slug, authz.ProjectEdit)
	if err != nil {
		return nil, err
	}
	e, err := p.svc.UpdateEnvironment(ctx, uid, t.ProjectID, in.Name, projects.EnvironmentUpdate{
		IsProduction: in.Body.IsProduction, Color: in.Body.Color, Hidden: in.Body.Hidden, Position: in.Body.Position,
	})
	if err != nil {
		return nil, p.problem(ctx, "update environment", err)
	}
	return &EnvironmentOutput{Body: toEnvironment(e)}, nil
}

func (p *Projects) reorderEnvironments(ctx context.Context, in *ReorderEnvironmentsInput) (*EnvironmentsOutput, error) {
	t, uid, err := authorizeProject(ctx, p.guard, p.logger, in.Slug, authz.ProjectEdit)
	if err != nil {
		return nil, err
	}
	envs, err := p.svc.ReorderEnvironments(ctx, uid, t.ProjectID, in.Body.Names)
	if err != nil {
		return nil, p.problem(ctx, "order environments", err)
	}
	return toEnvironments(envs), nil
}

func (p *Projects) pause(ctx context.Context, in *ProjectSlugInput) (*ProjectOutput, error) {
	return p.project(ctx, "pause project", in.Slug, authz.ProjectDelete, func(id, user uuid.UUID) (projects.Project, error) {
		return p.svc.Pause(ctx, user, id)
	})
}

func (p *Projects) resume(ctx context.Context, in *ProjectSlugInput) (*ProjectOutput, error) {
	return p.project(ctx, "resume project", in.Slug, authz.ProjectDelete, func(id, user uuid.UUID) (projects.Project, error) {
		return p.svc.Resume(ctx, user, id)
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
