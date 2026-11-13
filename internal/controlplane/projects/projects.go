// Package projects creates, reads, updates and deletes the projects of an
// organization and their environments, and answers whether a project slug is
// free.
//
// Project slugs are globally unique among active projects (the SDK's
// project_slug check relies on it); the partial unique index
// projects_slug_active is the final arbiter, so two concurrent creates of one
// slug end with exactly one winner. Creating and deleting a project write the
// project.created / project.deleted outbox rows (ADR 0006) in the same
// transaction as the change. With an auditor (WithAudit), creating and
// renaming a project and adding or removing an environment record
// project.created, project.updated, environment.added and
// environment.removed in the same transaction. Creating a project also registers its default
// app (slug = project slug), which receives records that name no app; other
// apps are created by ingest from the app names SDKs send.
//
// The service does not authorize: callers check the SpiceDB permission
// first with the authz guard (create_project on the organization; view,
// edit or delete on the project) and pass the project id it resolved.
package projects

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// EnvironmentPattern is the rule for environment names: letters, digits,
// '.', '_' and '-', starting with a letter or digit, at most 64 characters
// (environments.name allows 1..64).
const EnvironmentPattern = `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`

// MaxDescription bounds a project's description, in characters
// (projects.description allows 0..280).
const MaxDescription = 280

// MaxEnvironments bounds the environments of one project.
const MaxEnvironments = 20

// DefaultEnvironments are created when a create request names none.
var DefaultEnvironments = []string{"production"}

var envRE = regexp.MustCompile(EnvironmentPattern)

// ValidEnvironment reports whether name matches EnvironmentPattern.
func ValidEnvironment(name string) bool { return envRE.MatchString(name) }

// Errors returned by Service.
var (
	// ErrInvalid: the name, description, slug or an environment name is
	// unusable.
	ErrInvalid = errors.New("projects: invalid name, description, slug or environment")
	// ErrNotFound: no active project (or organization) has the id or slug,
	// or the user is not a member of the organization.
	ErrNotFound = errors.New("projects: not found")
	// ErrSlugImmutable: the update asks for a different slug.
	ErrSlugImmutable = errors.New("projects: slug cannot be changed")
	// ErrTooManyEnvironments: the project would have more than
	// MaxEnvironments environments.
	ErrTooManyEnvironments = errors.New("projects: too many environments")
)

// SlugTakenError is returned by Create when the slug is reserved or used by
// another active project. Suggestions are free alternatives.
type SlugTakenError struct {
	Suggestions []string
}

func (e *SlugTakenError) Error() string { return "projects: slug taken" }

// Project roles (authz/schema.zed project#admin/editor/viewer).
const (
	RoleAdmin  = "admin"
	RoleEditor = "editor"
	RoleViewer = "viewer"
)

// Project is a project as seen by a member of its organization.
type Project struct {
	ID          uuid.UUID
	Slug        string
	Name        string
	Description string
	OrgID       uuid.UUID
	OrgSlug     string
	// Role is the creator's effective project role on a project Create
	// returns; the other methods leave it empty for the caller to fill
	// from SpiceDB.
	Role         string
	Environments []string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	CreatedBy    *uuid.UUID // nil when unknown (older or seeded projects, purged user)
	// RepositoryURL is the project's source repository link (see
	// NormalizeRepositoryURL); nil when none is set.
	RepositoryURL *string
}

// Update is a partial update of a project; nil fields are left unchanged.
type Update struct {
	Name        *string
	Description *string
	Slug        *string
	// RepositoryURL sets the repository link; "" removes it.
	RepositoryURL *string
}

// creatorRole is the effective project role of a new project's creator:
// organization owners and admins are admin on every project; anyone else
// allowed to create projects (members) edits it through the default access
// org_role every new project starts with.
func creatorRole(orgRole string) string {
	if orgs.CanManage(orgRole) {
		return RoleAdmin
	}
	return RoleEditor
}

// Service manages projects and environments.
type Service struct {
	pool  *pgxpool.Pool
	audit apps.Auditor // nil: nothing is audited
	// anyRepositoryHost lets a repository link name any https host
	// (integrations.allow_any_repository_host), not only RepositoryHosts.
	anyRepositoryHost bool
}

// New returns a Service over pool.
func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// WithAudit audits project and environment changes and the creation of each
// new project's default app.
func (s *Service) WithAudit(a apps.Auditor) *Service {
	s.audit = a
	return s
}

// WithAnyRepositoryHost lets repository links name any https host, not only
// RepositoryHosts, and returns s.
func (s *Service) WithAnyRepositoryHost(allow bool) *Service {
	s.anyRepositoryHost = allow
	return s
}

// Create creates the project slug named name in the organization orgSlug on
// behalf of user (whom the caller authorized with create_project; a user who
// is not a member is ErrNotFound), with the given environments (DefaultEnvironments when
// empty; duplicates are dropped). name is trimmed. A reserved or taken slug
// returns *SlugTakenError.
func (s *Service) Create(ctx context.Context, user uuid.UUID, orgSlug, name, slug string, envs []string) (Project, error) {
	name = strings.TrimSpace(name)
	if name == "" || !orgs.ValidSlug(slug) {
		return Project{}, ErrInvalid
	}
	envs, err := environments(envs)
	if err != nil {
		return Project{}, err
	}
	if orgs.Reserved(slug) {
		return Project{}, s.taken(ctx, slug)
	}
	p, err := s.create(ctx, user, orgSlug, name, slug, envs)
	if isViolation(err, "23505", "projects_slug_active") {
		return Project{}, s.taken(ctx, slug)
	}
	return p, err
}

func (s *Service) create(ctx context.Context, user uuid.UUID, orgSlug, name, slug string, envs []string) (Project, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Project{}, fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	// Lock the organization so it cannot be deleted under the new project.
	org, err := q.LockMemberOrganization(ctx, db.LockMemberOrganizationParams{UserID: user, Slug: orgSlug})
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("projects: lock organization: %w", err)
	}
	p, err := q.CreateProject(ctx, db.CreateProjectParams{ID: uuid.New(), OrgID: org.ID, Slug: slug, Name: name, Description: "", CreatedBy: &user})
	if err != nil {
		return Project{}, fmt.Errorf("projects: create project: %w", err)
	}
	// The default app receives records that name no app; its slug is the
	// project slug, which older install instructions told SDKs to send. It
	// goes through apps.Insert, the code path ingest creates apps through.
	if _, _, err := apps.Insert(ctx, tx, s.audit, apps.NewApp{
		ProjectID: p.ID, OrgID: org.ID, Slug: p.Slug, Name: p.Name, Origin: apps.OriginDashboard, Default: true, Actor: &user,
	}); err != nil {
		return Project{}, fmt.Errorf("projects: create default app: %w", err)
	}
	for _, e := range envs {
		if _, err := q.CreateEnvironment(ctx, db.CreateEnvironmentParams{ID: uuid.New(), ProjectID: p.ID, Name: e}); err != nil {
			return Project{}, fmt.Errorf("projects: create environment: %w", err)
		}
	}
	if err := outbox.Emit(ctx, tx, outbox.ProjectCreated, p.ID, outbox.ProjectCreatedPayload{ProjectID: p.ID, OrgID: org.ID}); err != nil {
		return Project{}, err
	}
	slices.Sort(envs)
	if err := s.record(ctx, tx, user, org.ID, p.ID, audit.Event{
		Kind:    audit.ProjectCreated,
		Target:  projectTarget(p.ID, p.Name),
		Changes: audit.Diff(nil, map[string]any{"name": p.Name, "slug": p.Slug, "environments": envs}),
	}); err != nil {
		return Project{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Project{}, fmt.Errorf("projects: commit: %w", err)
	}
	return Project{
		ID: p.ID, Slug: p.Slug, Name: p.Name, Description: p.Description, OrgID: org.ID, OrgSlug: org.Slug, Role: creatorRole(org.Role),
		Environments: envs, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt, CreatedBy: p.CreatedBy, RepositoryURL: p.RepositoryUrl,
	}, nil
}

// taken builds the SlugTakenError for slug.
func (s *Service) taken(ctx context.Context, slug string) error {
	sug, err := s.Suggest(ctx, slug)
	if err != nil {
		return err
	}
	return &SlugTakenError{Suggestions: sug}
}

// Available reports whether slug can be used for a new project and, when it
// cannot, up to orgs.MaxSuggestions free alternatives. An invalid slug is
// ErrInvalid.
func (s *Service) Available(ctx context.Context, slug string) (bool, []string, error) {
	if !orgs.ValidSlug(slug) {
		return false, nil, ErrInvalid
	}
	if !orgs.Reserved(slug) {
		taken, err := db.New(s.pool).ProjectSlugTaken(ctx, slug)
		if err != nil {
			return false, nil, fmt.Errorf("projects: check slug: %w", err)
		}
		if !taken {
			return true, []string{}, nil
		}
	}
	sug, err := s.Suggest(ctx, slug)
	return false, sug, err
}

// Suggest returns up to orgs.MaxSuggestions valid, unreserved slugs derived
// from slug that no active project uses.
func (s *Service) Suggest(ctx context.Context, slug string) ([]string, error) {
	out, err := orgs.SuggestSlugs(ctx, slug, db.New(s.pool).TakenProjectSlugs)
	if err != nil {
		return nil, fmt.Errorf("projects: suggest slugs: %w", err)
	}
	return out, nil
}

// List returns the active projects of the organization orgSlug, which user
// must be a member of (ErrNotFound otherwise), ordered by name. It does not
// filter by project access: the caller keeps the projects user can view.
func (s *Service) List(ctx context.Context, user uuid.UUID, orgSlug string) ([]Project, error) {
	q := db.New(s.pool)
	org, err := q.GetMemberOrganization(ctx, db.GetMemberOrganizationParams{UserID: user, Slug: orgSlug})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("projects: get organization: %w", err)
	}
	rows, err := q.ListOrgProjects(ctx, org.ID)
	if err != nil {
		return nil, fmt.Errorf("projects: list: %w", err)
	}
	out := make([]Project, 0, len(rows))
	ids := make([]uuid.UUID, 0, len(rows))
	for _, r := range rows {
		out = append(out, Project{
			ID: r.ID, Slug: r.Slug, Name: r.Name, Description: r.Description, OrgID: org.ID, OrgSlug: org.Slug,
			Environments: []string{}, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, CreatedBy: r.CreatedBy, RepositoryURL: r.RepositoryUrl,
		})
		ids = append(ids, r.ID)
	}
	envs, err := listEnvironments(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		if e, ok := envs[out[i].ID]; ok {
			out[i].Environments = e
		}
	}
	return out, nil
}

// Get returns the active project id (ErrNotFound when it is gone).
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Project, error) {
	q := db.New(s.pool)
	r, err := q.GetActiveProject(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("projects: get: %w", err)
	}
	return withEnvironments(ctx, q, db.LockActiveProjectRow(r))
}

// Update applies u to the project id on behalf of user. The name and
// description are trimmed; an empty name, a description over MaxDescription
// characters or a repository link NormalizeRepositoryURL rejects is
// ErrInvalid, and a slug different from the current one is
// ErrSlugImmutable. An empty repository link removes it. A change moves
// updated_at and, in the same transaction, records project.updated with the
// previous and next values of the changed fields; an update that changes
// nothing writes nothing.
func (s *Service) Update(ctx context.Context, user, id uuid.UUID, u Update) (Project, error) {
	var name, desc string
	if u.Name != nil {
		name = strings.TrimSpace(*u.Name)
		if name == "" {
			return Project{}, ErrInvalid
		}
	}
	if u.Description != nil {
		desc = strings.TrimSpace(*u.Description)
		if utf8.RuneCountInString(desc) > MaxDescription {
			return Project{}, ErrInvalid
		}
	}
	var repo *string
	if u.RepositoryURL != nil {
		r, err := NormalizeRepositoryURL(*u.RepositoryURL, s.anyRepositoryHost)
		if err != nil {
			return Project{}, err
		}
		if r != "" {
			repo = &r
		}
	}
	if u.Slug != nil && !orgs.ValidSlug(*u.Slug) {
		return Project{}, ErrInvalid
	}
	return s.write(ctx, user, id, func(q *db.Queries, cur *db.LockActiveProjectRow) (*audit.Event, error) {
		if u.Slug != nil && *u.Slug != cur.Slug {
			return nil, ErrSlugImmutable
		}
		prev, next := map[string]any{}, map[string]any{}
		if u.Name != nil && name != cur.Name {
			prev["name"], next["name"] = cur.Name, name
		} else {
			name = cur.Name
		}
		if u.Description != nil && desc != cur.Description {
			prev["description"], next["description"] = cur.Description, desc
		} else {
			desc = cur.Description
		}
		if u.RepositoryURL != nil && !equalPtr(repo, cur.RepositoryUrl) {
			prev["repository_url"], next["repository_url"] = ptrValue(cur.RepositoryUrl), ptrValue(repo)
		} else {
			repo = cur.RepositoryUrl
		}
		if len(next) == 0 {
			return nil, nil
		}
		p, err := q.UpdateProjectDetails(ctx, db.UpdateProjectDetailsParams{ID: cur.ID, Name: name, Description: desc, RepositoryUrl: repo})
		if err != nil {
			return nil, fmt.Errorf("projects: update: %w", err)
		}
		cur.Name, cur.Description, cur.RepositoryUrl, cur.UpdatedAt = p.Name, p.Description, p.RepositoryUrl, p.UpdatedAt
		changes := audit.Diff(prev, next)
		if changes == nil {
			return nil, nil
		}
		return &audit.Event{Kind: audit.ProjectUpdated, Target: projectTarget(cur.ID, cur.Name), Changes: changes}, nil
	})
}

// AddEnvironment adds the environment name to the project id on behalf of
// user. Adding an environment the project already has changes nothing.
func (s *Service) AddEnvironment(ctx context.Context, user, id uuid.UUID, name string) (Project, error) {
	if !ValidEnvironment(name) {
		return Project{}, ErrInvalid
	}
	return s.write(ctx, user, id, func(q *db.Queries, cur *db.LockActiveProjectRow) (*audit.Event, error) {
		envs, err := listEnvironments(ctx, q, []uuid.UUID{cur.ID})
		if err != nil {
			return nil, err
		}
		if slices.Contains(envs[cur.ID], name) {
			return nil, nil
		}
		if len(envs[cur.ID]) >= MaxEnvironments {
			return nil, ErrTooManyEnvironments
		}
		if _, err := q.CreateEnvironment(ctx, db.CreateEnvironmentParams{ID: uuid.New(), ProjectID: cur.ID, Name: name}); err != nil {
			return nil, fmt.Errorf("projects: create environment: %w", err)
		}
		return &audit.Event{
			Kind: audit.EnvironmentAdded, Target: environmentTarget(name),
			Changes: audit.Diff(nil, map[string]any{"name": name}),
		}, nil
	})
}

// RemoveEnvironment removes the environment name from the project id on
// behalf of user.
// Removing an environment the project does not have changes nothing.
// Telemetry already recorded for the environment is kept.
func (s *Service) RemoveEnvironment(ctx context.Context, user, id uuid.UUID, name string) (Project, error) {
	return s.write(ctx, user, id, func(q *db.Queries, cur *db.LockActiveProjectRow) (*audit.Event, error) {
		n, err := q.DeleteEnvironment(ctx, db.DeleteEnvironmentParams{ProjectID: cur.ID, Name: name})
		if err != nil {
			return nil, fmt.Errorf("projects: delete environment: %w", err)
		}
		if n == 0 {
			return nil, nil
		}
		return &audit.Event{
			Kind: audit.EnvironmentRemoved, Target: environmentTarget(name),
			Changes: audit.Diff(map[string]any{"name": name}, nil),
		}, nil
	})
}

// Delete soft-deletes the project id. In the same transaction it emits the
// project.deleted outbox row (the relay then drops the project's
// relationships from SpiceDB). The slug becomes free for a new project.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := lock(ctx, q, id)
	if err != nil {
		return err
	}
	if _, err := q.SoftDeleteProject(ctx, cur.ID); err != nil {
		return fmt.Errorf("projects: delete: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.ProjectDeleted, cur.ID, outbox.ProjectDeletedPayload{ProjectID: cur.ID}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("projects: commit: %w", err)
	}
	return nil
}

// write runs fn in a transaction on the row-locked project id, records the
// event fn returns (nil: no change) as done by user in the same transaction,
// then returns the project as fn left it.
func (s *Service) write(ctx context.Context, user, id uuid.UUID,
	fn func(q *db.Queries, cur *db.LockActiveProjectRow) (*audit.Event, error),
) (Project, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Project{}, fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := lock(ctx, q, id)
	if err != nil {
		return Project{}, err
	}
	ev, err := fn(q, &cur)
	if err != nil {
		return Project{}, err
	}
	if ev != nil {
		if err := s.record(ctx, tx, user, cur.OrgID, cur.ID, *ev); err != nil {
			return Project{}, err
		}
	}
	out, err := withEnvironments(ctx, q, cur)
	if err != nil {
		return Project{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Project{}, fmt.Errorf("projects: commit: %w", err)
	}
	return out, nil
}

// record writes e, done by user to the project projectID of the
// organization orgID, in tx; a Service without an auditor records nothing.
func (s *Service) record(ctx context.Context, tx pgx.Tx, user, orgID, projectID uuid.UUID, e audit.Event) error {
	if s.audit == nil {
		return nil
	}
	e.User, e.Actor, e.Org, e.Project = &user, &user, &orgID, &projectID
	return s.audit.Record(audit.WithTx(ctx, tx), e)
}

func projectTarget(id uuid.UUID, name string) audit.Target {
	return audit.Target{Type: "project", ID: id.String(), Label: name}
}

// environmentTarget names an environment by its name, the key the API and
// the SDK use for it.
func environmentTarget(name string) audit.Target {
	return audit.Target{Type: "environment", ID: name, Label: name}
}

// lock row-locks the active project id.
func lock(ctx context.Context, q *db.Queries, id uuid.UUID) (db.LockActiveProjectRow, error) {
	cur, err := q.LockActiveProject(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return cur, ErrNotFound
	}
	if err != nil {
		return cur, fmt.Errorf("projects: lock project: %w", err)
	}
	return cur, nil
}

func withEnvironments(ctx context.Context, q *db.Queries, r db.LockActiveProjectRow) (Project, error) {
	envs, err := listEnvironments(ctx, q, []uuid.UUID{r.ID})
	if err != nil {
		return Project{}, err
	}
	e := envs[r.ID]
	if e == nil {
		e = []string{}
	}
	return Project{
		ID: r.ID, Slug: r.Slug, Name: r.Name, Description: r.Description, OrgID: r.OrgID, OrgSlug: r.OrgSlug,
		Environments: e, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, CreatedBy: r.CreatedBy, RepositoryURL: r.RepositoryUrl,
	}, nil
}

// listEnvironments returns the environment names of each project, sorted.
func listEnvironments(ctx context.Context, q *db.Queries, ids []uuid.UUID) (map[uuid.UUID][]string, error) {
	out := map[uuid.UUID][]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.ListProjectsEnvironments(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("projects: list environments: %w", err)
	}
	for _, r := range rows {
		out[r.ProjectID] = append(out[r.ProjectID], r.Name)
	}
	return out, nil
}

// environments validates and deduplicates the environments of a create
// request, defaulting to DefaultEnvironments.
func environments(in []string) ([]string, error) {
	if len(in) == 0 {
		return slices.Clone(DefaultEnvironments), nil
	}
	out := make([]string, 0, len(in))
	for _, e := range in {
		if !ValidEnvironment(e) {
			return nil, ErrInvalid
		}
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	if len(out) > MaxEnvironments {
		return nil, ErrTooManyEnvironments
	}
	return out, nil
}

// equalPtr reports whether a and b are both nil or point to equal strings.
func equalPtr(a, b *string) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

// ptrValue is *p, or nil (JSON null in an audit diff) when p is nil.
func ptrValue(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// isViolation reports whether err is the Postgres error code, on constraint
// when it is not empty.
func isViolation(err error, code, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code && (constraint == "" || pgErr.ConstraintName == constraint)
}
