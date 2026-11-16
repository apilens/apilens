package projects

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// MaxNewSDKEnvironmentsPerHour bounds the environments ingest registers in
// one project per rolling hour (#788), so an SDK that puts a build number or
// host name in the environment does not fill the project's list.
const MaxNewSDKEnvironmentsPerHour = 5

// EnvironmentLimitError is returned by EnvironmentProvisioner.Register when
// registering would exceed a limit. Records for the environment are still
// stored; the environment is just not listed.
type EnvironmentLimitError struct {
	Limit string // EnvLimitMax or EnvLimitNewPerHour
	Max   int
}

func (e *EnvironmentLimitError) Error() string {
	return fmt.Sprintf("projects: %s (%d) reached", e.Limit, e.Max)
}

// Environment limit names.
const (
	EnvLimitMax        = "max_environments"
	EnvLimitNewPerHour = "max_new_environments_per_hour"
)

// EnvironmentProvisioner registers the environments SDKs report. Registers
// are serialised per project by a row lock on the project, so the limits are
// exact across concurrent edges.
type EnvironmentProvisioner struct {
	pool  *pgxpool.Pool
	audit apps.Auditor
	now   func() time.Time
}

// NewEnvironmentProvisioner returns an EnvironmentProvisioner over pool.
// auditor may be nil.
func NewEnvironmentProvisioner(pool *pgxpool.Pool, auditor apps.Auditor) *EnvironmentProvisioner {
	return &EnvironmentProvisioner{pool: pool, audit: auditor, now: time.Now}
}

// Register adds the environment name to the project with source 'sdk' and
// seenAt as first and last seen, unless it exists (then it only moves
// last_seen_at). created reports whether this call added it. It returns
// *EnvironmentLimitError when the project has MaxEnvironments environments
// or MaxNewSDKEnvironmentsPerHour were registered in the last hour,
// ErrInvalid for a name that does not match EnvironmentPattern and
// apps.ErrProjectGone when the project was deleted. Registering audits
// environment.added with by=sdk and the key whose data named it.
func (p *EnvironmentProvisioner) Register(ctx context.Context, projectID, keyID uuid.UUID, name string, seenAt time.Time) (created bool, err error) {
	if !ValidEnvironment(name) {
		return false, ErrInvalid
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	project, err := q.LockProjectByID(ctx, projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, apps.ErrProjectGone
	}
	if err != nil {
		return false, fmt.Errorf("projects: lock project: %w", err)
	}
	seen := seenAt.UTC()
	n, err := q.TouchEnvironmentSeen(ctx, db.TouchEnvironmentSeenParams{ProjectID: projectID, Name: name, SeenAt: &seen})
	if err != nil {
		return false, fmt.Errorf("projects: touch environment: %w", err)
	}
	if n == 0 {
		if err := checkEnvironmentLimits(ctx, q, projectID, p.now()); err != nil {
			return false, err
		}
		if _, err := q.RegisterSDKEnvironment(ctx, db.RegisterSDKEnvironmentParams{
			ID: uuid.New(), ProjectID: projectID, Name: name, SeenAt: &seen,
		}); err != nil {
			return false, fmt.Errorf("projects: register environment: %w", err)
		}
		created = true
		if p.audit != nil {
			if err := p.audit.Record(audit.WithTx(ctx, tx), audit.Event{
				Kind: audit.EnvironmentAdded, Org: &project.OrgID, Project: &projectID, Target: environmentTarget(name),
				Changes: audit.Diff(nil, map[string]any{"name": name}),
				Meta:    map[string]any{"project_id": projectID.String(), "by": SourceSDK, "key_id": keyID.String()},
			}); err != nil {
				return false, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("projects: commit: %w", err)
	}
	return created, nil
}

// environmentCounter is the store subset checkEnvironmentLimits needs.
type environmentCounter interface {
	CountProjectEnvironments(ctx context.Context, projectID uuid.UUID) (int64, error)
	CountSDKEnvironmentsSince(ctx context.Context, arg db.CountSDKEnvironmentsSinceParams) (int64, error)
}

// checkEnvironmentLimits answers *EnvironmentLimitError when the project
// may not get another SDK environment at now.
func checkEnvironmentLimits(ctx context.Context, q environmentCounter, projectID uuid.UUID, now time.Time) error {
	total, err := q.CountProjectEnvironments(ctx, projectID)
	if err != nil {
		return fmt.Errorf("projects: count environments: %w", err)
	}
	if total >= MaxEnvironments {
		return &EnvironmentLimitError{Limit: EnvLimitMax, Max: MaxEnvironments}
	}
	recent, err := q.CountSDKEnvironmentsSince(ctx, db.CountSDKEnvironmentsSinceParams{ProjectID: projectID, Since: now.Add(-time.Hour)})
	if err != nil {
		return fmt.Errorf("projects: count new environments: %w", err)
	}
	if recent >= MaxNewSDKEnvironmentsPerHour {
		return &EnvironmentLimitError{Limit: EnvLimitNewPerHour, Max: MaxNewSDKEnvironmentsPerHour}
	}
	return nil
}
