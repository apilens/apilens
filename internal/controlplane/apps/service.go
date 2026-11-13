package apps

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// App states.
const (
	StateActive   = "active"
	StateArchived = "archived"
	StateMerged   = "merged"
	StateDeleted  = "deleted"
)

// App is an app as the Apps page lists it.
type App struct {
	ID               uuid.UUID
	Slug             string
	Name             string
	CreatedBy        string // OriginSDK or OriginDashboard
	CreatedByKeyID   *uuid.UUID
	CreatedByKeyName *string
	CreatedAt        time.Time
	FirstSeenAt      *time.Time
	LastSeenAt       *time.Time
	ArchivedAt       *time.Time
	DeletedAt        *time.Time
	AcknowledgedAt   *time.Time
	IsDefault        bool
	MergedInto       *uuid.UUID
	MergedIntoSlug   *string
	State            string
	// New: created by the SDK in the last NewAppWindow and not acknowledged.
	New bool
	// RestorableUntil: when a deleted app's slug stops being reserved.
	RestorableUntil *time.Time
}

// Errors returned by Service.
var (
	ErrNotFound    = errors.New("apps: app not found")
	ErrInvalid     = errors.New("apps: invalid request")
	ErrDefaultApp  = errors.New("apps: the default app cannot be archived, merged or deleted")
	ErrSlugTaken   = errors.New("apps: another app uses the slug")
	ErrNotArchived = errors.New("apps: the app is active")
)

// Service manages the apps of a project from the dashboard. Callers check
// the project permission first (view to read, manage_capture to write) and
// pass the project id the check resolved.
type Service struct {
	pool     *pgxpool.Pool
	audit    Auditor
	now      func() time.Time
	onChange func(projectID uuid.UUID)
}

// NewService returns a Service over pool. auditor may be nil.
func NewService(pool *pgxpool.Pool, auditor Auditor) *Service {
	return &Service{pool: pool, audit: auditor, now: time.Now}
}

// OnChange is called after every committed change, to drop the project from
// this process's resolver cache.
func (s *Service) OnChange(fn func(projectID uuid.UUID)) *Service {
	s.onChange = fn
	return s
}

// List returns the project's apps: active ones first, then archived and
// merged ones, then apps deleted in the last DeletedReservation.
func (s *Service) List(ctx context.Context, projectID uuid.UUID) ([]App, error) {
	q := db.New(s.pool)
	now := s.now()
	since := now.Add(-DeletedReservation)
	rows, err := q.ListManagedApps(ctx, db.ListManagedAppsParams{ProjectID: projectID, DeletedSince: &since})
	if err != nil {
		return nil, fmt.Errorf("apps: list: %w", err)
	}
	seen, err := q.ListAppsLastSeen(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("apps: last seen: %w", err)
	}
	last := make(map[uuid.UUID]time.Time, len(seen))
	for _, r := range seen {
		last[r.AppID] = r.LastSeenAt
	}
	out := make([]App, 0, len(rows))
	for _, r := range rows {
		a := App{
			ID: r.ID, Slug: r.Slug, Name: r.Name, CreatedBy: r.CreatedBy, CreatedByKeyID: r.CreatedByKeyID,
			CreatedByKeyName: r.CreatedByKeyName, CreatedAt: r.CreatedAt, FirstSeenAt: r.FirstSeenAt,
			ArchivedAt: r.ArchivedAt, DeletedAt: r.DeletedAt, AcknowledgedAt: r.AcknowledgedAt, IsDefault: r.IsDefault,
			MergedInto: r.MergedInto, MergedIntoSlug: r.MergedIntoSlug, State: StateActive,
		}
		if t, ok := last[r.ID]; ok {
			a.LastSeenAt = &t
		}
		switch {
		case r.DeletedAt != nil:
			a.State = StateDeleted
			until := r.DeletedAt.Add(DeletedReservation)
			a.RestorableUntil = &until
		case r.MergedInto != nil:
			a.State = StateMerged
		case r.ArchivedAt != nil:
			a.State = StateArchived
		}
		a.New = a.State == StateActive && r.CreatedBy == OriginSDK && r.AcknowledgedAt == nil && now.Sub(r.CreatedAt) < NewAppWindow
		out = append(out, a)
	}
	return out, nil
}

// write runs fn on the locked app id of the project, audits kind with meta
// (fn may add to it) and commits.
func (s *Service) write(ctx context.Context, actor, projectID, id uuid.UUID, kind audit.Kind,
	fn func(q *db.Queries, a db.LockProjectAppRow, meta map[string]any) error,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("apps: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err := q.LockProjectByID(ctx, projectID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("apps: lock project: %w", err)
	}
	a, err := q.LockProjectApp(ctx, db.LockProjectAppParams{ProjectID: projectID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("apps: lock app: %w", err)
	}
	meta := map[string]any{"project_id": projectID.String(), "app_id": a.ID.String(), "slug": a.Slug}
	if err := fn(q, a, meta); err != nil {
		return err
	}
	if s.audit != nil && kind != "" {
		if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{User: &actor, Actor: &actor, Kind: kind, Meta: meta}); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		if isUnique(err) {
			return ErrSlugTaken
		}
		return fmt.Errorf("apps: commit: %w", err)
	}
	if s.onChange != nil {
		s.onChange(projectID)
	}
	return nil
}

// Rename changes the display name; the slug the SDK sends never changes.
func (s *Service) Rename(ctx context.Context, actor, projectID, id uuid.UUID, name string) error {
	name = DisplayName(name)
	if name == "" {
		return ErrInvalid
	}
	return s.write(ctx, actor, projectID, id, audit.AppRenamed, func(q *db.Queries, a db.LockProjectAppRow, meta map[string]any) error {
		if a.DeletedAt != nil {
			return ErrNotFound
		}
		meta["from"], meta["to"] = a.Name, name
		return q.RenameApp(ctx, db.RenameAppParams{ID: a.ID, Name: name})
	})
}

// Archive hides an app from the dashboard. Data naming it un-archives it.
func (s *Service) Archive(ctx context.Context, actor, projectID, id uuid.UUID) error {
	return s.write(ctx, actor, projectID, id, audit.AppArchived, func(q *db.Queries, a db.LockProjectAppRow, _ map[string]any) error {
		switch {
		case a.DeletedAt != nil:
			return ErrNotFound
		case a.IsDefault:
			return ErrDefaultApp
		}
		if err := q.AcknowledgeApp(ctx, a.ID); err != nil {
			return fmt.Errorf("apps: acknowledge: %w", err)
		}
		return q.ArchiveApp(ctx, a.ID)
	})
}

// Restore brings back an archived, merged or deleted app. A merged app's
// slug stops being an alias, so its data lands in it again. ErrSlugTaken
// when a newer app uses the slug of a deleted one.
func (s *Service) Restore(ctx context.Context, actor, projectID, id uuid.UUID) error {
	return s.write(ctx, actor, projectID, id, audit.AppRestored, func(q *db.Queries, a db.LockProjectAppRow, meta map[string]any) error {
		if a.DeletedAt == nil && a.ArchivedAt == nil && a.MergedInto == nil {
			return ErrNotArchived
		}
		if a.DeletedAt != nil {
			if a.DeletedAt.Before(s.now().Add(-DeletedReservation)) {
				return ErrNotFound
			}
			if _, err := q.GetActiveAppBySlug(ctx, db.GetActiveAppBySlugParams{ProjectID: projectID, Slug: a.Slug}); err == nil {
				return ErrSlugTaken
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("apps: get app: %w", err)
			}
		}
		meta["by"] = OriginDashboard
		if err := q.DeleteAppAlias(ctx, db.DeleteAppAliasParams{ProjectID: projectID, AliasSlug: a.Slug}); err != nil {
			return fmt.Errorf("apps: drop alias: %w", err)
		}
		return q.RestoreApp(ctx, a.ID)
	})
}

// Delete deletes an app. Its slug stays reserved for DeletedReservation:
// data naming it is rejected, and Restore brings it back. Aliases to it go
// and apps merged into it stay archived.
func (s *Service) Delete(ctx context.Context, actor, projectID, id uuid.UUID) error {
	return s.write(ctx, actor, projectID, id, audit.AppDeleted, func(q *db.Queries, a db.LockProjectAppRow, _ map[string]any) error {
		switch {
		case a.DeletedAt != nil:
			return nil
		case a.IsDefault:
			return ErrDefaultApp
		}
		if err := q.DeleteAppAliasesTo(ctx, a.ID); err != nil {
			return fmt.Errorf("apps: drop aliases: %w", err)
		}
		if err := q.UnmergeAppsFrom(ctx, &a.ID); err != nil {
			return fmt.Errorf("apps: unmerge: %w", err)
		}
		if err := q.AcknowledgeApp(ctx, a.ID); err != nil {
			return fmt.Errorf("apps: acknowledge: %w", err)
		}
		return q.DeleteApp(ctx, a.ID)
	})
}

// Acknowledge keeps a new app the SDK created: it stops counting as new.
func (s *Service) Acknowledge(ctx context.Context, actor, projectID, id uuid.UUID) error {
	return s.write(ctx, actor, projectID, id, audit.AppAcknowledged, func(q *db.Queries, a db.LockProjectAppRow, _ map[string]any) error {
		if a.DeletedAt != nil {
			return ErrNotFound
		}
		return q.AcknowledgeApp(ctx, a.ID)
	})
}

// Merge merges the app source into target: source is archived, its slug
// (and its aliases) route to target from now on, and apps merged into it
// follow. Records already stored stay under source.
func (s *Service) Merge(ctx context.Context, actor, projectID, source, target uuid.UUID) error {
	if source == target {
		return ErrInvalid
	}
	return s.write(ctx, actor, projectID, source, audit.AppMerged, func(q *db.Queries, a db.LockProjectAppRow, meta map[string]any) error {
		switch {
		case a.DeletedAt != nil:
			return ErrNotFound
		case a.IsDefault:
			return ErrDefaultApp
		}
		t, err := q.LockProjectApp(ctx, db.LockProjectAppParams{ProjectID: projectID, ID: target})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("apps: lock target: %w", err)
		}
		if t.DeletedAt != nil || t.ArchivedAt != nil || t.MergedInto != nil {
			return ErrInvalid
		}
		meta["into_app_id"], meta["into_slug"] = t.ID.String(), t.Slug
		if err := q.MergeApp(ctx, db.MergeAppParams{SourceID: a.ID, TargetID: &t.ID}); err != nil {
			return fmt.Errorf("apps: merge: %w", err)
		}
		if err := q.RepointMergedApps(ctx, db.RepointMergedAppsParams{SourceID: &a.ID, TargetID: &t.ID}); err != nil {
			return fmt.Errorf("apps: repoint merged apps: %w", err)
		}
		if err := q.RepointAppAliases(ctx, db.RepointAppAliasesParams{SourceID: a.ID, TargetID: t.ID}); err != nil {
			return fmt.Errorf("apps: repoint aliases: %w", err)
		}
		return q.UpsertAppAlias(ctx, db.UpsertAppAliasParams{ProjectID: projectID, AliasSlug: a.Slug, AppID: t.ID})
	})
}

func isUnique(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && strings.HasPrefix(pg.ConstraintName, "apps_")
}
