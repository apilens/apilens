package privacy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// Errors returned by Service.
var (
	// ErrNotFound: no active project has the slug, or the user is not a
	// member of its organization. The cases are deliberately
	// indistinguishable.
	ErrNotFound = errors.New("privacy: project not found")
	// ErrForbidden: the user is a member but their role does not allow the
	// change.
	ErrForbidden = errors.New("privacy: forbidden")
	// ErrUnknownApp: the project has no active app with the identifier.
	ErrUnknownApp = errors.New("privacy: unknown app")
)

// App names the app a policy is scoped to.
type App struct {
	ID   uuid.UUID
	Slug string
}

// Scoped is the stored policy of a project (App nil) or one of its apps.
// UpdatedAt is nil when the scope has no policy yet (only the defaults
// apply).
type Scoped struct {
	App       *App
	Policy    Policy
	UpdatedAt *time.Time
}

// Service reads and replaces privacy policies on behalf of signed-in users.
// Any member of the project's organization may read them; owners, admins and
// members may change them (the project edit permission).
type Service struct {
	pool  *pgxpool.Pool
	audit Auditor // nil: policy changes are not audited
}

// Auditor records audit events; *audit.Recorder satisfies it.
type Auditor interface {
	Record(ctx context.Context, e audit.Event) error
}

// NewService returns a Service over pool.
func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// WithAudit records privacy_policy.updated, in the transaction of the
// change, for every policy change.
func (s *Service) WithAudit(a Auditor) *Service {
	s.audit = a
	return s
}

// Get returns the policy of the project slug, or of its app when app (a
// slug or id) is not empty.
func (s *Service) Get(ctx context.Context, user uuid.UUID, slug, app string) (Scoped, error) {
	q := db.New(s.pool)
	p, err := q.GetMemberProject(ctx, db.GetMemberProjectParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return Scoped{}, ErrNotFound
	}
	if err != nil {
		return Scoped{}, fmt.Errorf("privacy: get project: %w", err)
	}
	scope, err := resolveApp(ctx, q, p.ID, app)
	if err != nil {
		return Scoped{}, err
	}
	out := Scoped{App: scope, Policy: Policy{QueryParams: []string{}, Headers: []string{}, BodyFields: []string{}}}
	row, err := q.GetPrivacyPolicy(ctx, db.GetPrivacyPolicyParams{ProjectID: p.ID, AppID: appID(scope)})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return out, nil
	case err != nil:
		return Scoped{}, fmt.Errorf("privacy: get policy: %w", err)
	}
	out.Policy = Policy{QueryParams: row.MaskQueryParams, Headers: row.MaskHeaders, BodyFields: row.MaskBodyFields}
	out.UpdatedAt = &row.UpdatedAt
	return out, nil
}

// Put replaces the policy of the project slug (or of its app) with pol,
// after Normalize. user must be an owner, admin or member of the project's
// organization. Edges pick the change up within one app cache TTL.
func (s *Service) Put(ctx context.Context, user uuid.UUID, slug, app string, pol Policy) (Scoped, error) {
	pol, err := pol.Normalize()
	if err != nil {
		return Scoped{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Scoped{}, fmt.Errorf("privacy: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := q.LockMemberProject(ctx, db.LockMemberProjectParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return Scoped{}, ErrNotFound
	}
	if err != nil {
		return Scoped{}, fmt.Errorf("privacy: lock project: %w", err)
	}
	if !projects.CanWrite(p.Role) {
		return Scoped{}, ErrForbidden
	}
	scope, err := resolveApp(ctx, q, p.ID, app)
	if err != nil {
		return Scoped{}, err
	}
	previous := Policy{QueryParams: []string{}, Headers: []string{}, BodyFields: []string{}}
	switch prev, err := q.GetPrivacyPolicy(ctx, db.GetPrivacyPolicyParams{ProjectID: p.ID, AppID: appID(scope)}); {
	case err == nil:
		previous = Policy{QueryParams: prev.MaskQueryParams, Headers: prev.MaskHeaders, BodyFields: prev.MaskBodyFields}
	case !errors.Is(err, pgx.ErrNoRows):
		return Scoped{}, fmt.Errorf("privacy: get policy: %w", err)
	}
	row, err := q.UpsertPrivacyPolicy(ctx, db.UpsertPrivacyPolicyParams{
		ID: uuid.New(), ProjectID: p.ID, AppID: appID(scope),
		MaskQueryParams: pol.QueryParams, MaskHeaders: pol.Headers, MaskBodyFields: pol.BodyFields,
	})
	if err != nil {
		return Scoped{}, fmt.Errorf("privacy: upsert policy: %w", err)
	}
	next := Policy{QueryParams: row.MaskQueryParams, Headers: row.MaskHeaders, BodyFields: row.MaskBodyFields}
	if changes := audit.Diff(policyValues(previous), policyValues(next)); changes != nil && s.audit != nil {
		target := audit.Target{Type: "project", ID: p.ID.String(), Label: p.Name}
		if scope != nil {
			target = audit.Target{Type: "app", ID: scope.ID.String(), Label: scope.Slug}
		}
		if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
			User: &user, Actor: &user, Kind: audit.PrivacyPolicyUpdated,
			Org: &p.OrgID, Project: &p.ID, Target: target, Changes: changes,
		}); err != nil {
			return Scoped{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Scoped{}, fmt.Errorf("privacy: commit: %w", err)
	}
	return Scoped{
		App:       scope,
		Policy:    Policy{QueryParams: row.MaskQueryParams, Headers: row.MaskHeaders, BodyFields: row.MaskBodyFields},
		UpdatedAt: &row.UpdatedAt,
	}, nil
}

// policyValues is pol as audit changes record it: the masked patterns,
// which are field names and never values.
func policyValues(pol Policy) map[string]any {
	return map[string]any{"query_params": orEmpty(pol.QueryParams), "headers": orEmpty(pol.Headers), "body_fields": orEmpty(pol.BodyFields)}
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// resolveApp maps an app slug or id to an active app of the project; an
// empty identifier is the project scope (nil).
func resolveApp(ctx context.Context, q *db.Queries, projectID uuid.UUID, ident string) (*App, error) {
	ident = strings.TrimSpace(ident)
	if ident == "" {
		return nil, nil
	}
	rows, err := q.ListProjectApps(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("privacy: list apps: %w", err)
	}
	id, idErr := uuid.Parse(ident)
	for _, row := range rows {
		if row.Slug == ident || (idErr == nil && row.ID == id) {
			return &App{ID: row.ID, Slug: row.Slug}, nil
		}
	}
	return nil, ErrUnknownApp
}

func appID(a *App) *uuid.UUID {
	if a == nil {
		return nil
	}
	return &a.ID
}
