// Package projects creates, reads, updates and deletes the projects of an
// organization and their environments, and answers whether a project slug is
// free.
//
// Project slugs are globally unique among active projects (the SDK's
// project_slug check relies on it); the partial unique index
// projects_slug_active is the final arbiter, so two concurrent creates of one
// slug end with exactly one winner. Creating and deleting a project write the
// project.created / project.deleted outbox rows (ADR 0006) in the same
// transaction as the change. Creating a project also registers its default
// app (slug = project slug), which receives records that name no app; other
// apps are created by ingest from the app names SDKs send.
//
// Role checks read memberships until the authz middleware lands; they follow
// authz/schema.zed: any member may read, owners, admins and members may
// create and edit projects (create_project, edit), and only owners and admins
// may delete them (org->manage).
package projects

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// EnvironmentPattern is the rule for environment names: letters, digits,
// '.', '_' and '-', starting with a letter or digit, at most 64 characters
// (environments.name allows 1..64).
const EnvironmentPattern = `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`

// MaxEnvironments bounds the environments of one project.
const MaxEnvironments = 20

// DefaultEnvironments are created when a create request names none.
var DefaultEnvironments = []string{"production"}

var envRE = regexp.MustCompile(EnvironmentPattern)

// ValidEnvironment reports whether name matches EnvironmentPattern.
func ValidEnvironment(name string) bool { return envRE.MatchString(name) }

// Errors returned by Service.
var (
	// ErrInvalid: the name, slug or an environment name is unusable.
	ErrInvalid = errors.New("projects: invalid name, slug or environment")
	// ErrNotFound: no active project (or organization) has the slug, or the
	// user is not a member of its organization. The cases are deliberately
	// indistinguishable.
	ErrNotFound = errors.New("projects: not found")
	// ErrForbidden: the user is a member but their role does not allow the
	// change.
	ErrForbidden = errors.New("projects: forbidden")
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

// Project is a project as seen by a member of its organization.
type Project struct {
	ID           uuid.UUID
	Slug         string
	Name         string
	OrgID        uuid.UUID
	OrgSlug      string
	Role         string // the user's role in the organization
	Environments []string
	CreatedAt    time.Time
}

// Update is a partial update of a project; nil fields are left unchanged.
type Update struct {
	Name *string
	Slug *string
}

// CanWrite reports whether an organization role may create and edit
// projects and their environments.
func CanWrite(role string) bool {
	return role == orgs.RoleOwner || role == orgs.RoleAdmin || role == "member"
}

// CanDelete reports whether an organization role may delete projects.
func CanDelete(role string) bool { return orgs.CanManage(role) }

// Service manages projects and environments.
type Service struct {
	pool  *pgxpool.Pool
	audit apps.Auditor // nil: the default app's app.created is not audited
}

// New returns a Service over pool.
func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// WithAudit audits the creation of each new project's default app.
func (s *Service) WithAudit(a apps.Auditor) *Service {
	s.audit = a
	return s
}

// Create creates the project slug named name in the organization orgSlug on
// behalf of user, with the given environments (DefaultEnvironments when
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
	if !CanWrite(org.Role) {
		return Project{}, ErrForbidden
	}
	p, err := q.CreateProject(ctx, db.CreateProjectParams{ID: uuid.New(), OrgID: org.ID, Slug: slug, Name: name})
	if err != nil {
		return Project{}, fmt.Errorf("projects: create project: %w", err)
	}
	// The default app receives records that name no app; its slug is the
	// project slug, which older install instructions told SDKs to send. It
	// goes through apps.Insert, the code path ingest creates apps through.
	if _, _, err := apps.Insert(ctx, tx, s.audit, apps.NewApp{
		ProjectID: p.ID, Slug: p.Slug, Name: p.Name, Origin: apps.OriginDashboard, Default: true, Actor: &user,
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
	if err := tx.Commit(ctx); err != nil {
		return Project{}, fmt.Errorf("projects: commit: %w", err)
	}
	slices.Sort(envs)
	return Project{
		ID: p.ID, Slug: p.Slug, Name: p.Name, OrgID: org.ID, OrgSlug: org.Slug, Role: org.Role,
		Environments: envs, CreatedAt: p.CreatedAt,
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
// must be a member of (ErrNotFound otherwise), ordered by name.
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
			ID: r.ID, Slug: r.Slug, Name: r.Name, OrgID: org.ID, OrgSlug: org.Slug, Role: org.Role,
			Environments: []string{}, CreatedAt: r.CreatedAt,
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

// Get returns the active project slug as seen by user, who must be a member
// of its organization (ErrNotFound otherwise).
func (s *Service) Get(ctx context.Context, user uuid.UUID, slug string) (Project, error) {
	q := db.New(s.pool)
	r, err := q.GetMemberProject(ctx, db.GetMemberProjectParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("projects: get: %w", err)
	}
	return withEnvironments(ctx, q, db.LockMemberProjectRow(r))
}

// Update applies u to the project slug on behalf of user, who must be an
// owner, admin or member of its organization. The name is trimmed; a slug
// different from the current one is ErrSlugImmutable.
func (s *Service) Update(ctx context.Context, user uuid.UUID, slug string, u Update) (Project, error) {
	var name string
	if u.Name != nil {
		name = strings.TrimSpace(*u.Name)
		if name == "" {
			return Project{}, ErrInvalid
		}
	}
	if u.Slug != nil && !orgs.ValidSlug(*u.Slug) {
		return Project{}, ErrInvalid
	}
	return s.write(ctx, user, slug, CanWrite, func(q *db.Queries, cur *db.LockMemberProjectRow) error {
		if u.Slug != nil && *u.Slug != cur.Slug {
			return ErrSlugImmutable
		}
		if u.Name == nil {
			return nil
		}
		p, err := q.UpdateProjectName(ctx, db.UpdateProjectNameParams{ID: cur.ID, Name: name})
		if err != nil {
			return fmt.Errorf("projects: update: %w", err)
		}
		cur.Name = p.Name
		return nil
	})
}

// AddEnvironment adds the environment name to the project slug on behalf of
// user, who must be an owner, admin or member of its organization. Adding an
// environment the project already has changes nothing.
func (s *Service) AddEnvironment(ctx context.Context, user uuid.UUID, slug, name string) (Project, error) {
	if !ValidEnvironment(name) {
		return Project{}, ErrInvalid
	}
	return s.write(ctx, user, slug, CanWrite, func(q *db.Queries, cur *db.LockMemberProjectRow) error {
		envs, err := listEnvironments(ctx, q, []uuid.UUID{cur.ID})
		if err != nil {
			return err
		}
		if slices.Contains(envs[cur.ID], name) {
			return nil
		}
		if len(envs[cur.ID]) >= MaxEnvironments {
			return ErrTooManyEnvironments
		}
		if _, err := q.CreateEnvironment(ctx, db.CreateEnvironmentParams{ID: uuid.New(), ProjectID: cur.ID, Name: name}); err != nil {
			return fmt.Errorf("projects: create environment: %w", err)
		}
		return nil
	})
}

// RemoveEnvironment removes the environment name from the project slug on
// behalf of user, who must be an owner, admin or member of its organization.
// Removing an environment the project does not have changes nothing.
// Telemetry already recorded for the environment is kept.
func (s *Service) RemoveEnvironment(ctx context.Context, user uuid.UUID, slug, name string) (Project, error) {
	return s.write(ctx, user, slug, CanWrite, func(q *db.Queries, cur *db.LockMemberProjectRow) error {
		if _, err := q.DeleteEnvironment(ctx, db.DeleteEnvironmentParams{ProjectID: cur.ID, Name: name}); err != nil {
			return fmt.Errorf("projects: delete environment: %w", err)
		}
		return nil
	})
}

// Delete soft-deletes the project slug on behalf of user, who must be an
// owner or admin of its organization. In the same transaction it emits the
// project.deleted outbox row (the relay then drops the project's
// relationships from SpiceDB). The slug becomes free for a new project.
func (s *Service) Delete(ctx context.Context, user uuid.UUID, slug string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := lock(ctx, q, user, slug, CanDelete)
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

// write runs fn in a transaction on the row-locked project slug after
// checking user's role with allowed, then returns the project as fn left it.
func (s *Service) write(ctx context.Context, user uuid.UUID, slug string, allowed func(string) bool,
	fn func(q *db.Queries, cur *db.LockMemberProjectRow) error,
) (Project, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Project{}, fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := lock(ctx, q, user, slug, allowed)
	if err != nil {
		return Project{}, err
	}
	if err := fn(q, &cur); err != nil {
		return Project{}, err
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

// lock row-locks the project slug for user's membership in its organization
// and checks the role with allowed.
func lock(ctx context.Context, q *db.Queries, user uuid.UUID, slug string, allowed func(string) bool) (db.LockMemberProjectRow, error) {
	cur, err := q.LockMemberProject(ctx, db.LockMemberProjectParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return cur, ErrNotFound
	}
	if err != nil {
		return cur, fmt.Errorf("projects: lock project: %w", err)
	}
	if !allowed(cur.Role) {
		return cur, ErrForbidden
	}
	return cur, nil
}

func withEnvironments(ctx context.Context, q *db.Queries, r db.LockMemberProjectRow) (Project, error) {
	envs, err := listEnvironments(ctx, q, []uuid.UUID{r.ID})
	if err != nil {
		return Project{}, err
	}
	e := envs[r.ID]
	if e == nil {
		e = []string{}
	}
	return Project{
		ID: r.ID, Slug: r.Slug, Name: r.Name, OrgID: r.OrgID, OrgSlug: r.OrgSlug, Role: r.Role,
		Environments: e, CreatedAt: r.CreatedAt,
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

// isViolation reports whether err is the Postgres error code, on constraint
// when it is not empty.
func isViolation(err error, code, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code && (constraint == "" || pgErr.ConstraintName == constraint)
}
