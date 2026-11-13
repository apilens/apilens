package projects

// Environment settings (#787, D11 in #753): each environment has a
// production flag, a colour from a fixed palette, a position in the
// project's order and a hidden state. An environment is hidden rather than
// deleted once it has data: removing one that has data within retention, an
// active API key pinned to it or a health check using it is
// ErrEnvironmentInUse. Hidden environments still ingest; pickers leave them
// out by default.
//
// Every change runs in a transaction on the row-locked project, so changes
// to one project's environments are serialised, and records
// environment.updated (target: the environment) with the previous and next
// values in the same transaction.

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// Colors is the fixed palette an environment's colour comes from
// (environments.color); the UI maps each name to a token and shows its name
// next to it.
var Colors = []string{"gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"}

// ColorNone clears an environment's colour in an EnvironmentUpdate.
const ColorNone = "none"

// Environment sources (environments.source).
const (
	SourceSDK       = "sdk"
	SourceDashboard = "dashboard"
)

// DefaultDataRetention is how long data keeps an environment in use when the
// service is not told the install's retention: the longest default telemetry
// retention (hour rollups, 400 days).
const DefaultDataRetention = 400 * 24 * time.Hour

var (
	// ErrEnvironmentNotFound: the project has no environment of that name.
	ErrEnvironmentNotFound = errors.New("projects: environment not found")
	// ErrEnvironmentInUse: the environment has data within retention, or an
	// active API key or a health check refers to it; hide it instead.
	ErrEnvironmentInUse = errors.New("projects: environment in use")
)

// Environment is one environment of a project with its settings.
type Environment struct {
	Name         string
	IsProduction bool
	Color        *string // nil: no colour
	Position     int
	HiddenAt     *time.Time // nil: visible
	Source       string     // SourceSDK or SourceDashboard
	FirstSeenAt  *time.Time // nil: no data seen yet
	LastSeenAt   *time.Time
	CreatedAt    time.Time
	// HasData is whether data for the environment was seen within the data
	// retention (LastSeenAt).
	HasData bool
	// APIKeys is the number of active API keys pinned to the environment;
	// HealthChecks the number of health checks that use it.
	APIKeys      int
	HealthChecks int
}

// Hidden reports whether the environment is hidden.
func (e Environment) Hidden() bool { return e.HiddenAt != nil }

// InUse reports whether the environment cannot be deleted: it has data
// within retention, or an API key or a health check refers to it.
func (e Environment) InUse() bool { return e.HasData || e.APIKeys > 0 || e.HealthChecks > 0 }

// EnvironmentUpdate is a partial update of an environment; nil fields are
// left unchanged.
type EnvironmentUpdate struct {
	IsProduction *bool
	// Color is one of Colors, or ColorNone to clear it.
	Color  *string
	Hidden *bool
	// Position moves the environment to that index of the project's order
	// (clamped to the order's bounds); the others keep their relative order.
	Position *int
}

// WithDataRetention sets how long data seen for an environment keeps it in
// use (the install's longest telemetry retention) and returns s. Zero or
// less means DefaultDataRetention.
func (s *Service) WithDataRetention(d time.Duration) *Service {
	s.retention = d
	return s
}

func (s *Service) dataRetention() time.Duration {
	if s.retention <= 0 {
		return DefaultDataRetention
	}
	return s.retention
}

// ListEnvironments returns the environments of the active project id in
// display order (ErrNotFound when the project is gone).
func (s *Service) ListEnvironments(ctx context.Context, id uuid.UUID) ([]Environment, error) {
	q := db.New(s.pool)
	if _, err := q.GetActiveProject(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, fmt.Errorf("projects: get: %w", err)
	}
	return s.environmentDetails(ctx, q, id)
}

// UpdateEnvironment applies u to the environment name of the project id on
// behalf of user and returns it. An unknown colour is ErrInvalid; an
// environment the project does not have is ErrEnvironmentNotFound. An update
// that changes nothing writes nothing.
func (s *Service) UpdateEnvironment(ctx context.Context, user, id uuid.UUID, name string, u EnvironmentUpdate) (Environment, error) {
	if u.Color != nil && *u.Color != ColorNone && !slices.Contains(Colors, *u.Color) {
		return Environment{}, ErrInvalid
	}
	envs, err := s.writeEnvironments(ctx, user, id, func(q *db.Queries, cur []Environment) ([]audit.Event, error) {
		i := slices.IndexFunc(cur, func(e Environment) bool { return e.Name == name })
		if i < 0 {
			return nil, ErrEnvironmentNotFound
		}
		e := cur[i]
		prev, next := map[string]any{}, map[string]any{}
		prod, color, hidden := e.IsProduction, e.Color, e.HiddenAt
		if u.IsProduction != nil && *u.IsProduction != prod {
			prev["is_production"], next["is_production"] = prod, *u.IsProduction
			prod = *u.IsProduction
		}
		if u.Color != nil {
			var c *string
			if *u.Color != ColorNone {
				c = u.Color
			}
			if !sameColor(c, color) {
				prev["color"], next["color"] = colorValue(color), colorValue(c)
				color = c
			}
		}
		if u.Hidden != nil && *u.Hidden != e.Hidden() {
			prev["hidden"], next["hidden"] = e.Hidden(), *u.Hidden
			hidden = nil
			if *u.Hidden {
				now := time.Now().UTC()
				hidden = &now
			}
		}
		if len(next) > 0 {
			if _, err := q.UpdateEnvironmentSettings(ctx, db.UpdateEnvironmentSettingsParams{
				ProjectID: id, Name: name, IsProduction: prod, Color: color, HiddenAt: hidden,
			}); err != nil {
				return nil, fmt.Errorf("projects: update environment: %w", err)
			}
		}
		if u.Position != nil {
			order := names(cur)
			order = slices.Delete(order, i, i+1)
			to := min(max(*u.Position, 0), len(order))
			order = slices.Insert(order, to, name)
			if to != i {
				prev["position"], next["position"] = i, to
				if err := q.SetEnvironmentPositions(ctx, db.SetEnvironmentPositionsParams{ProjectID: id, Names: order}); err != nil {
					return nil, fmt.Errorf("projects: order environments: %w", err)
				}
			}
		}
		if len(next) == 0 {
			return nil, nil
		}
		return []audit.Event{{Kind: audit.EnvironmentUpdated, Target: environmentTarget(name), Changes: audit.Diff(prev, next)}}, nil
	})
	if err != nil {
		return Environment{}, err
	}
	for _, e := range envs {
		if e.Name == name {
			return e, nil
		}
	}
	return Environment{}, ErrEnvironmentNotFound
}

// ReorderEnvironments orders the environments of the project id on behalf
// of user: the named ones first, in the given order, then the others in
// their current order. A name the project does not have or a duplicate is
// ErrInvalid. It returns the environments in their new order and records
// environment.updated for each one whose position changed.
func (s *Service) ReorderEnvironments(ctx context.Context, user, id uuid.UUID, order []string) ([]Environment, error) {
	for i, n := range order {
		if !ValidEnvironment(n) || slices.Contains(order[:i], n) {
			return nil, ErrInvalid
		}
	}
	return s.writeEnvironments(ctx, user, id, func(q *db.Queries, cur []Environment) ([]audit.Event, error) {
		all := names(cur)
		next := slices.Clone(order)
		for _, n := range order {
			if !slices.Contains(all, n) {
				return nil, ErrInvalid
			}
		}
		for _, n := range all {
			if !slices.Contains(next, n) {
				next = append(next, n)
			}
		}
		var events []audit.Event
		for to, n := range next {
			if from := slices.Index(all, n); from != to {
				events = append(events, audit.Event{
					Kind: audit.EnvironmentUpdated, Target: environmentTarget(n),
					Changes: audit.Diff(map[string]any{"position": from}, map[string]any{"position": to}),
				})
			}
		}
		if len(events) == 0 && positionsDense(cur) {
			return nil, nil
		}
		if err := q.SetEnvironmentPositions(ctx, db.SetEnvironmentPositionsParams{ProjectID: id, Names: next}); err != nil {
			return nil, fmt.Errorf("projects: order environments: %w", err)
		}
		return events, nil
	})
}

// positionsDense reports whether the environments' stored positions are
// already 0..n-1 in display order.
func positionsDense(envs []Environment) bool {
	for i, e := range envs {
		if e.Position != i {
			return false
		}
	}
	return true
}

// writeEnvironments runs fn in a transaction on the row-locked project id
// with its environments in display order, records the events fn returns as
// done by user in the same transaction, then returns the environments as fn
// left them.
func (s *Service) writeEnvironments(ctx context.Context, user, id uuid.UUID,
	fn func(q *db.Queries, cur []Environment) ([]audit.Event, error),
) ([]Environment, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("projects: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lock(ctx, q, id)
	if err != nil {
		return nil, err
	}
	cur, err := s.environmentDetails(ctx, q, p.ID)
	if err != nil {
		return nil, err
	}
	events, err := fn(q, cur)
	if err != nil {
		return nil, err
	}
	for _, ev := range events {
		if err := s.record(ctx, tx, user, p.OrgID, p.ID, ev); err != nil {
			return nil, err
		}
	}
	out, err := s.environmentDetails(ctx, q, p.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("projects: commit: %w", err)
	}
	return out, nil
}

// environmentDetails reads the environments of the project id in display
// order.
func (s *Service) environmentDetails(ctx context.Context, q *db.Queries, id uuid.UUID) ([]Environment, error) {
	rows, err := q.ListProjectEnvironmentDetails(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("projects: list environments: %w", err)
	}
	since := time.Now().Add(-s.dataRetention())
	out := make([]Environment, 0, len(rows))
	for _, r := range rows {
		out = append(out, Environment{
			Name: r.Name, IsProduction: r.IsProduction, Color: r.Color, Position: int(r.Position),
			HiddenAt: r.HiddenAt, Source: r.Source, FirstSeenAt: r.FirstSeenAt, LastSeenAt: r.LastSeenAt,
			CreatedAt: r.CreatedAt, HasData: r.LastSeenAt != nil && r.LastSeenAt.After(since),
			APIKeys: int(r.ApiKeys), HealthChecks: int(r.HealthChecks),
		})
	}
	return out, nil
}

func names(envs []Environment) []string {
	out := make([]string, len(envs))
	for i, e := range envs {
		out[i] = e.Name
	}
	return out
}

// colorValue is c as recorded in audit changes: the name, or nil.
func colorValue(c *string) any {
	if c == nil {
		return nil
	}
	return *c
}

func sameColor(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
