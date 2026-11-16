package apps

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// Origins of an app (apps.created_by).
const (
	OriginSDK       = "sdk"
	OriginDashboard = "dashboard"
)

// DeletedReservation is how long the slug of a deleted app stays reserved:
// data naming it is rejected until then, and a new app may take the slug
// after.
const DeletedReservation = 30 * 24 * time.Hour

// NewAppWindow is how long an app the SDK created counts as "new" on the
// Apps page unless someone acknowledges it.
const NewAppWindow = 7 * 24 * time.Hour

// Auditor records audit events; *audit.Recorder satisfies it. Record must
// write in the transaction audit.WithTx puts in the context.
type Auditor interface {
	Record(ctx context.Context, e audit.Event) error
}

// NewApp describes an app to create.
type NewApp struct {
	ProjectID uuid.UUID
	OrgID     uuid.UUID // the project's organization, for the audit event
	Slug      string    // must satisfy ValidSlug
	Name      string
	Origin    string     // OriginSDK or OriginDashboard
	KeyID     *uuid.UUID // the ingest key whose data created it (OriginSDK)
	Default   bool       // the project's default app
	Actor     *uuid.UUID // the user who created it (OriginDashboard), if any
	Now       time.Time
}

// Insert creates the app in tx and audits app.created there. This is the
// one code path every app is created through: the default app of a new
// project (projects.Service) and apps ingest creates from the names SDKs
// send (Provisioner). A concurrent create of the same slug wins: created is
// false and the existing app is returned. auditor may be nil.
func Insert(ctx context.Context, tx pgx.Tx, auditor Auditor, a NewApp) (id uuid.UUID, created bool, err error) {
	if !ValidSlug(a.Slug) {
		return uuid.Nil, false, fmt.Errorf("apps: invalid slug %q", a.Slug)
	}
	if a.Name == "" {
		a.Name = a.Slug
	}
	if a.Now.IsZero() {
		a.Now = time.Now()
	}
	q := db.New(tx)
	p := db.InsertAppParams{
		ID: uuid.New(), ProjectID: a.ProjectID, Slug: a.Slug, Name: a.Name,
		CreatedBy: a.Origin, CreatedByKeyID: a.KeyID, IsDefault: a.Default,
	}
	if a.Origin == OriginSDK {
		p.FirstSeenAt = &a.Now
	} else {
		// Nobody needs to be told about an app they created.
		p.AcknowledgedAt = &a.Now
	}
	row, err := q.InsertApp(ctx, p)
	if errors.Is(err, pgx.ErrNoRows) {
		existing, err := q.GetActiveAppBySlug(ctx, db.GetActiveAppBySlugParams{ProjectID: a.ProjectID, Slug: a.Slug})
		if err != nil {
			return uuid.Nil, false, fmt.Errorf("apps: get existing app: %w", err)
		}
		return existing.ID, false, nil
	}
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("apps: insert: %w", err)
	}
	if auditor != nil {
		meta := map[string]any{
			"project_id": a.ProjectID.String(), "app_id": row.ID.String(), "slug": row.Slug, "name": row.Name,
			"created_by": a.Origin, "default": a.Default,
		}
		if a.KeyID != nil {
			meta["key_id"] = a.KeyID.String()
		}
		if err := auditor.Record(audit.WithTx(ctx, tx), audit.Event{
			User: a.Actor, Actor: a.Actor, Kind: audit.AppCreated,
			Org: orgRef(a.OrgID), Project: &a.ProjectID, Target: appTarget(row.ID, row.Name),
			Changes: &audit.Changes{Next: map[string]any{"slug": row.Slug, "name": row.Name, "default": a.Default}},
			Meta:    meta,
		}); err != nil {
			return uuid.Nil, false, err
		}
	}
	return row.ID, true, nil
}

// Limits bound how many apps the SDK may create.
type Limits struct {
	// MaxApps bounds the apps (archived ones included) of a project; 0
	// disables the limit.
	MaxApps int
	// MaxNewPerHour bounds the apps the SDK creates in a project per rolling
	// hour; 0 disables the limit.
	MaxNewPerHour int
}

// LimitError is returned when creating an app would exceed a Limits value.
type LimitError struct {
	Limit string // "max_apps_per_project" or "max_new_apps_per_hour"
	Max   int
}

func (e *LimitError) Error() string { return fmt.Sprintf("apps: %s (%d) reached", e.Limit, e.Max) }

// Limit names.
const (
	LimitMaxApps       = "max_apps_per_project"
	LimitMaxNewPerHour = "max_new_apps_per_hour"
)

// DeletedError is returned when data names a recently deleted app.
type DeletedError struct {
	Slug      string
	DeletedAt time.Time
}

func (e *DeletedError) Error() string {
	return fmt.Sprintf("apps: app %s was deleted on %s", e.Slug, e.DeletedAt.UTC().Format(time.DateOnly))
}

// ErrProjectGone: the project was deleted.
var ErrProjectGone = errors.New("apps: project not found")

// Provisioner creates apps on behalf of ingest: from an unknown app name,
// the project's default app, and un-archiving an archived app data names.
// Creates are serialised per project by a row lock on the project, so the
// limits are exact across concurrent batches and edges.
type Provisioner struct {
	pool   *pgxpool.Pool
	audit  Auditor
	limits Limits
	now    func() time.Time
}

// NewProvisioner returns a Provisioner over pool. auditor may be nil.
func NewProvisioner(pool *pgxpool.Pool, auditor Auditor, limits Limits) *Provisioner {
	return &Provisioner{pool: pool, audit: auditor, limits: limits, now: time.Now}
}

func (p *Provisioner) tx(ctx context.Context, projectID uuid.UUID, fn func(q *db.Queries, tx pgx.Tx, project db.LockProjectByIDRow) error) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("apps: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	project, err := q.LockProjectByID(ctx, projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrProjectGone
	}
	if err != nil {
		return fmt.Errorf("apps: lock project: %w", err)
	}
	if err := fn(q, tx, project); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("apps: commit: %w", err)
	}
	return nil
}

// Create returns the app slug of the project, creating it as an SDK app
// named name when it does not exist. It returns *DeletedError when the slug
// belongs to an app deleted in the last DeletedReservation and *LimitError
// when a limit is reached.
func (p *Provisioner) Create(ctx context.Context, projectID, keyID uuid.UUID, slug, name string) (uuid.UUID, bool, error) {
	var id uuid.UUID
	var created bool
	err := p.tx(ctx, projectID, func(q *db.Queries, tx pgx.Tx, project db.LockProjectByIDRow) error {
		now := p.now()
		existing, err := q.GetActiveAppBySlug(ctx, db.GetActiveAppBySlugParams{ProjectID: projectID, Slug: slug})
		if err == nil {
			id = existing.ID
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("apps: get app: %w", err)
		}
		since := now.Add(-DeletedReservation)
		deleted, err := q.GetRecentlyDeletedApp(ctx, db.GetRecentlyDeletedAppParams{ProjectID: projectID, Slug: slug, DeletedSince: &since})
		switch {
		case err == nil && deleted.DeletedAt != nil:
			return &DeletedError{Slug: slug, DeletedAt: *deleted.DeletedAt}
		case err != nil && !errors.Is(err, pgx.ErrNoRows):
			return fmt.Errorf("apps: get deleted app: %w", err)
		}
		if p.limits.MaxApps > 0 {
			n, err := q.CountActiveApps(ctx, projectID)
			if err != nil {
				return fmt.Errorf("apps: count apps: %w", err)
			}
			if n >= int64(p.limits.MaxApps) {
				return &LimitError{Limit: LimitMaxApps, Max: p.limits.MaxApps}
			}
		}
		if p.limits.MaxNewPerHour > 0 {
			n, err := q.CountSDKAppsSince(ctx, db.CountSDKAppsSinceParams{ProjectID: projectID, Since: now.Add(-time.Hour)})
			if err != nil {
				return fmt.Errorf("apps: count new apps: %w", err)
			}
			if n >= int64(p.limits.MaxNewPerHour) {
				return &LimitError{Limit: LimitMaxNewPerHour, Max: p.limits.MaxNewPerHour}
			}
		}
		key := keyID
		id, created, err = Insert(ctx, tx, p.audit, NewApp{
			ProjectID: projectID, OrgID: project.OrgID, Slug: slug, Name: name, Origin: OriginSDK, KeyID: &key, Now: now,
		})
		return err
	})
	return id, created, err
}

// EnsureDefault returns the project's default app. A project without one
// (created before default apps were flagged, or whose default app was
// deleted) promotes the app named after the project or "default", or gets a
// new "default" app. The limits do not apply.
func (p *Provisioner) EnsureDefault(ctx context.Context, projectID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := p.tx(ctx, projectID, func(q *db.Queries, tx pgx.Tx, project db.LockProjectByIDRow) error {
		if d, err := q.GetDefaultApp(ctx, projectID); err == nil {
			id = d.ID
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("apps: get default app: %w", err)
		}
		for _, slug := range []string{project.Slug, DefaultSlug} {
			a, err := q.GetActiveAppBySlug(ctx, db.GetActiveAppBySlugParams{ProjectID: projectID, Slug: slug})
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && a.MergedInto != nil) {
				continue
			}
			if err != nil {
				return fmt.Errorf("apps: get app: %w", err)
			}
			if err := q.SetAppDefault(ctx, a.ID); err != nil {
				return fmt.Errorf("apps: set default app: %w", err)
			}
			id = a.ID
			return nil
		}
		var err error
		id, _, err = Insert(ctx, tx, p.audit, NewApp{
			ProjectID: projectID, OrgID: project.OrgID, Slug: DefaultSlug, Name: "Default", Origin: OriginSDK, Default: true, Now: p.now(),
		})
		return err
	})
	return id, err
}

// Unarchive brings back an archived app because data named it, and audits
// app.restored with by=sdk. An app that is not archived (or was merged into
// another) is left alone.
func (p *Provisioner) Unarchive(ctx context.Context, projectID, appID, keyID uuid.UUID) error {
	return p.tx(ctx, projectID, func(q *db.Queries, tx pgx.Tx, project db.LockProjectByIDRow) error {
		row, err := q.UnarchiveApp(ctx, appID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("apps: unarchive: %w", err)
		}
		if p.audit == nil {
			return nil
		}
		return p.audit.Record(audit.WithTx(ctx, tx), audit.Event{
			Kind: audit.AppRestored, Org: &project.OrgID, Project: &projectID, Target: appTarget(row.ID, row.Name),
			Meta: map[string]any{
				"project_id": projectID.String(), "app_id": row.ID.String(), "slug": row.Slug, "by": OriginSDK, "key_id": keyID.String(),
			}})
	})
}

// appTarget is the audit target of an app event.
func appTarget(id uuid.UUID, name string) audit.Target {
	return audit.Target{Type: "app", ID: id.String(), Label: name}
}

// orgRef is id, or nil when it is unset.
func orgRef(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}
