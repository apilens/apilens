package projects

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// WithKeyInvalidation makes Pause and Resume drop the project's key hashes
// from every verifier cache through invalidate (an apikeys.Invalidator), so
// the change reaches the ingest edge at once rather than within the key
// cache TTL. It returns s.
func (s *Service) WithKeyInvalidation(invalidate func(ctx context.Context, hash string) error) *Service {
	s.invalidate = invalidate
	return s
}

// Pause pauses ingest for the project id on behalf of user: from then on
// (within the key cache TTL) the ingest edge answers 403 project_paused to
// every call made with one of the project's keys. Data already stored, the
// dashboard and the query API are unaffected. In the same transaction it
// records project.paused. Pausing a paused project changes nothing.
func (s *Service) Pause(ctx context.Context, user, id uuid.UUID) (Project, error) {
	return s.setPaused(ctx, user, id, true)
}

// Resume resumes ingest for the project id on behalf of user and records
// project.resumed in the same transaction. Resuming a project that is not
// paused changes nothing.
func (s *Service) Resume(ctx context.Context, user, id uuid.UUID) (Project, error) {
	return s.setPaused(ctx, user, id, false)
}

func (s *Service) setPaused(ctx context.Context, user, id uuid.UUID, pause bool) (Project, error) {
	var hashes []string
	p, err := s.write(ctx, user, id, func(q *db.Queries, cur *db.LockActiveProjectRow) (*audit.Event, error) {
		var (
			n    int64
			err  error
			kind = audit.ProjectResumed
		)
		if pause {
			n, err = q.PauseProject(ctx, db.PauseProjectParams{ID: cur.ID, PausedBy: &user})
			kind = audit.ProjectPaused
		} else {
			n, err = q.ResumeProject(ctx, cur.ID)
		}
		if err != nil {
			return nil, fmt.Errorf("projects: set paused: %w", err)
		}
		if n == 0 {
			return nil, nil
		}
		if s.invalidate != nil {
			if hashes, err = q.ListProjectKeyHashes(ctx, cur.ID); err != nil {
				return nil, fmt.Errorf("projects: list key hashes: %w", err)
			}
		}
		return &audit.Event{
			Kind: kind, Target: projectTarget(cur.ID, cur.Name),
			Changes: audit.Diff(map[string]any{"paused": !pause}, map[string]any{"paused": pause}),
		}, nil
	})
	if err != nil {
		return Project{}, err
	}
	// After the commit, so a verifier that reloads a key sees the change. A
	// failed invalidation only delays the change to the key cache TTL.
	for _, h := range hashes {
		if err := s.invalidate(ctx, h); err != nil {
			slog.WarnContext(ctx, "projects: could not invalidate api keys after a pause change", "project_id", id, "error", err)
			break
		}
	}
	return p, nil
}

// withPauses fills PausedAt and PausedBy of the projects in ps.
func withPauses(ctx context.Context, q *db.Queries, ps []Project) error {
	if len(ps) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(ps))
	for i, p := range ps {
		ids[i] = p.ID
	}
	rows, err := q.ListPausedProjects(ctx, ids)
	if err != nil {
		return fmt.Errorf("projects: list paused projects: %w", err)
	}
	paused := make(map[uuid.UUID]db.ListPausedProjectsRow, len(rows))
	for _, r := range rows {
		paused[r.ID] = r
	}
	for i := range ps {
		if r, ok := paused[ps[i].ID]; ok {
			at := r.PausedAt
			ps[i].PausedAt, ps[i].PausedBy = &at, r.PausedBy
		}
	}
	return nil
}
