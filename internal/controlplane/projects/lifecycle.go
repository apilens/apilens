package projects

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/notify"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// Project deletion (D8 in #753). Delete does not remove anything: it sets
// deleted_at and purge_after = now + the grace period, and from that moment
//
//   - the project is gone from every project endpoint (they read active
//     projects only) and from the organization's project list;
//   - project.deleted drops every SpiceDB relationship of the project, so
//     nobody, org owners and admins included, holds a project permission.
//     Postgres keeps what a restore needs (the default access and the
//     project_members rows); listing and restoring deleted projects are
//     organization operations (manage), so nothing needs the project's own
//     relationships while it waits;
//   - its API keys stop working: ingest answers 403 project_deleted, at
//     once because the keys are dropped from every ingest key cache;
//   - its slug stays reserved (projects_slug_reserved), so a restore never
//     collides with a newer project.
//
// Restore, before purge_after, clears both columns, writes the
// relationships back from Postgres (project.restored) and drops the keys
// from the caches again, so access and ingest are exactly as before. After
// purge_after the purge job (#796) removes the data.

// DefaultDeletionGrace is project.deletion_grace's default.
const DefaultDeletionGrace = 7 * 24 * time.Hour

// ErrConfirmMismatch: the delete confirmation is not the project's slug.
var ErrConfirmMismatch = errors.New("projects: confirmation does not match the slug")

// KeyInvalidator drops an API key hash from every ingest key cache.
type KeyInvalidator func(ctx context.Context, hash string) error

// Notifier emails a project's admins about a sensitive change in the
// caller's transaction (D13); *notify.Notifier satisfies it.
type Notifier interface {
	ProjectAdmins(ctx context.Context, tx pgx.Tx, project uuid.UUID, ev notify.Event) (int, error)
}

// WithNotifier emails the project admins when a project is scheduled for
// deletion or restored.
func (s *Service) WithNotifier(n Notifier) *Service {
	s.notifier = n
	return s
}

// WithDeletion sets how long a deleted project stays restorable (0: the
// purge is due at once) and how API keys are dropped from the ingest key
// caches when a project is deleted or restored (nil: the caches expire on
// their own); invalidate also serves Pause and Resume, as
// WithKeyInvalidation. Errors of invalidate are logged to logger (nil:
// slog.Default).
func (s *Service) WithDeletion(grace time.Duration, invalidate KeyInvalidator, logger *slog.Logger) *Service {
	s.grace = max(grace, 0)
	s.invalidate = invalidate
	if logger != nil {
		s.logger = logger
	}
	return s
}

// Scheduled is a deleted project waiting for its purge.
type Scheduled struct {
	ID          uuid.UUID
	Slug        string
	Name        string
	Description string
	CreatedAt   time.Time
	DeletedAt   time.Time
	// PurgeAfter is when the purge job may remove the project; it can be
	// restored until then.
	PurgeAfter time.Time
}

// Delete deletes the project id on behalf of user and schedules its purge
// after the grace period. confirm must be the project's slug
// (ErrConfirmMismatch otherwise, and nothing changes). In the same
// transaction it emits project.deleted, records project.deleted with the
// purge date and emails the project admins (WithNotifier); after the commit the project's API keys are dropped from the
// ingest key caches.
func (s *Service) Delete(ctx context.Context, user, id uuid.UUID, confirm string) (Scheduled, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Scheduled{}, fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := lock(ctx, q, id)
	if err != nil {
		return Scheduled{}, err
	}
	if confirm != cur.Slug {
		return Scheduled{}, ErrConfirmMismatch
	}
	row, err := q.ScheduleProjectDeletion(ctx, db.ScheduleProjectDeletionParams{ID: cur.ID, GraceSeconds: int64(s.grace / time.Second)})
	if err != nil {
		return Scheduled{}, fmt.Errorf("projects: delete: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.ProjectDeleted, cur.ID, outbox.ProjectDeletedPayload{ProjectID: cur.ID}); err != nil {
		return Scheduled{}, err
	}
	if err := s.record(ctx, tx, user, cur.OrgID, cur.ID, audit.Event{
		Kind:    audit.ProjectDeleted,
		Target:  projectTarget(cur.ID, cur.Name),
		Changes: audit.Diff(nil, map[string]any{"purge_after": row.PurgeAfter.UTC().Format(time.RFC3339)}),
	}); err != nil {
		return Scheduled{}, err
	}
	if s.notifier != nil {
		if _, err := s.notifier.ProjectAdmins(ctx, tx, cur.ID, notify.Event{Change: notify.DeletionScheduled, Actor: user, PurgeAt: row.PurgeAfter}); err != nil {
			return Scheduled{}, err
		}
	}
	hashes, err := q.ListProjectKeyHashes(ctx, cur.ID)
	if err != nil {
		return Scheduled{}, fmt.Errorf("projects: list keys: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Scheduled{}, fmt.Errorf("projects: commit: %w", err)
	}
	s.invalidateKeys(ctx, cur.ID, hashes)
	return Scheduled{
		ID: cur.ID, Slug: cur.Slug, Name: cur.Name, Description: cur.Description, CreatedAt: cur.CreatedAt,
		DeletedAt: row.DeletedAt, PurgeAfter: row.PurgeAfter,
	}, nil
}

// ListDeleted returns the deleted projects of the organization orgID that
// can still be restored, most recently deleted first.
func (s *Service) ListDeleted(ctx context.Context, orgID uuid.UUID) ([]Scheduled, error) {
	rows, err := db.New(s.pool).ListScheduledProjects(ctx, orgID)
	if err != nil {
		return nil, fmt.Errorf("projects: list deleted: %w", err)
	}
	out := make([]Scheduled, 0, len(rows))
	for _, r := range rows {
		out = append(out, Scheduled{
			ID: r.ID, Slug: r.Slug, Name: r.Name, Description: r.Description, CreatedAt: r.CreatedAt,
			DeletedAt: r.DeletedAt, PurgeAfter: r.PurgeAfter,
		})
	}
	return out, nil
}

// Restore brings back the deleted project id of the organization orgID on
// behalf of user, before its purge (ErrNotFound when there is no such
// project or the purge is due). In the same transaction it emits
// project.restored with the default access and direct grants Postgres kept
// records project.restored and emails the project admins; after the commit the project's API keys are
// dropped from the ingest key caches so they work again at once. The
// returned project has no Role: the caller fills it.
func (s *Service) Restore(ctx context.Context, user, orgID, id uuid.UUID) (Project, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Project{}, fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := q.LockScheduledProject(ctx, db.LockScheduledProjectParams{ID: id, OrgID: orgID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("projects: lock deleted project: %w", err)
	}
	if _, err := q.RestoreProject(ctx, cur.ID); err != nil {
		return Project{}, fmt.Errorf("projects: restore: %w", err)
	}
	grants, err := q.ListProjectMemberRoles(ctx, cur.ID)
	if err != nil {
		return Project{}, fmt.Errorf("projects: list grants: %w", err)
	}
	members := make([]outbox.ProjectMemberGrant, 0, len(grants))
	for _, g := range grants {
		members = append(members, outbox.ProjectMemberGrant{UserID: g.UserID, Role: g.Role})
	}
	if err := outbox.Emit(ctx, tx, outbox.ProjectRestored, cur.ID, outbox.ProjectRestoredPayload{
		ProjectID: cur.ID, OrgID: cur.OrgID, DefaultAccess: cur.DefaultAccess, Members: members,
	}); err != nil {
		return Project{}, err
	}
	if err := s.record(ctx, tx, user, cur.OrgID, cur.ID, audit.Event{
		Kind:    audit.ProjectRestored,
		Target:  projectTarget(cur.ID, cur.Name),
		Changes: audit.Diff(map[string]any{"purge_after": cur.PurgeAfter.UTC().Format(time.RFC3339)}, nil),
	}); err != nil {
		return Project{}, err
	}
	if s.notifier != nil {
		if _, err := s.notifier.ProjectAdmins(ctx, tx, cur.ID, notify.Event{Change: notify.Restored, Actor: user}); err != nil {
			return Project{}, err
		}
	}
	hashes, err := q.ListProjectKeyHashes(ctx, cur.ID)
	if err != nil {
		return Project{}, fmt.Errorf("projects: list keys: %w", err)
	}
	out, err := withEnvironments(ctx, q, db.LockActiveProjectRow{
		ID: cur.ID, Slug: cur.Slug, Name: cur.Name, Description: cur.Description, CreatedAt: cur.CreatedAt,
		UpdatedAt: cur.UpdatedAt, CreatedBy: cur.CreatedBy, RepositoryUrl: cur.RepositoryUrl, OrgID: cur.OrgID, OrgSlug: cur.OrgSlug,
	})
	if err != nil {
		return Project{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Project{}, fmt.Errorf("projects: commit: %w", err)
	}
	s.invalidateKeys(ctx, cur.ID, hashes)
	return out, nil
}

// invalidateKeys drops the key hashes of project from the ingest key caches.
// The change is committed by then, so a failure is logged, not returned: the
// caches still expire on their own (ingest.key_cache_ttl).
func (s *Service) invalidateKeys(ctx context.Context, project uuid.UUID, hashes []string) {
	if s.invalidate == nil {
		return
	}
	for _, h := range hashes {
		if err := s.invalidate(ctx, h); err != nil {
			s.logger.WarnContext(ctx, "failed to invalidate api key cache", "project_id", project, "error", err)
		}
	}
}
