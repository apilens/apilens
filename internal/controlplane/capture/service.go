package capture

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

// ErrUnknownApp: no active app (of an active project) has the id.
var ErrUnknownApp = errors.New("capture: unknown app")

// App is an active app and the project it belongs to.
type App struct {
	ID          uuid.UUID
	Slug        string
	ProjectID   uuid.UUID
	ProjectSlug string
	OrgID       uuid.UUID
}

// Stored is the policy of an app. UpdatedAt and UpdatedBy are nil when the
// app has no stored row (the policy is Default).
type Stored struct {
	App       App
	Policy    Policy
	UpdatedAt *time.Time
	UpdatedBy *uuid.UUID
}

// Auditor records audit events; *audit.Recorder satisfies it. Record must
// write in the transaction audit.WithTx puts in the context.
type Auditor interface {
	Record(ctx context.Context, e audit.Event) error
}

// Service reads and replaces capture policies. It does not authorize:
// callers check the project permission (view to read, manage_capture to
// write) on the app's project first.
type Service struct {
	pool  *pgxpool.Pool
	audit Auditor
}

// NewService returns a Service over pool, auditing changes with auditor.
func NewService(pool *pgxpool.Pool, auditor Auditor) *Service {
	return &Service{pool: pool, audit: auditor}
}

// App returns the active app with the id, or ErrUnknownApp.
func (s *Service) App(ctx context.Context, id uuid.UUID) (App, error) {
	return lookupApp(ctx, db.New(s.pool), id)
}

// Get returns the policy of app.
func (s *Service) Get(ctx context.Context, app App) (Stored, error) {
	row, err := db.New(s.pool).GetCapturePolicy(ctx, app.ID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return Stored{App: app, Policy: Default()}, nil
	case err != nil:
		return Stored{}, fmt.Errorf("capture: get policy: %w", err)
	}
	return Stored{
		App:       app,
		Policy:    fromRow(row.Enabled, row.SampleRate, row.CaptureHeaders, row.CaptureRequestBody, row.CaptureResponseBody, row.MaxPayloadBytes),
		UpdatedAt: &row.UpdatedAt,
		UpdatedBy: row.UpdatedBy,
	}, nil
}

// Put replaces the policy of app with pol on behalf of actor and audits
// capture_policy.updated in the same transaction. Edges serve the change on
// heartbeat within one resolver cache TTL.
func (s *Service) Put(ctx context.Context, actor uuid.UUID, app App, pol Policy) (Stored, error) {
	if err := pol.Validate(); err != nil {
		return Stored{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Stored{}, fmt.Errorf("capture: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	// Re-read the app inside the transaction so a policy is never written
	// for an app deleted since the caller looked it up.
	if app, err = lookupApp(ctx, q, app.ID); err != nil {
		return Stored{}, err
	}
	var maxBytes *int32
	if pol.MaxPayloadBytes != nil {
		v := int32(*pol.MaxPayloadBytes) //nolint:gosec // Validate bounds it to MaxPayloadBytesLimit.
		maxBytes = &v
	}
	row, err := q.UpsertCapturePolicy(ctx, db.UpsertCapturePolicyParams{
		AppID:               app.ID,
		Enabled:             pol.Enabled,
		SampleRate:          pol.SampleRate,
		CaptureHeaders:      pol.CaptureHeaders,
		CaptureRequestBody:  pol.CaptureRequestBody,
		CaptureResponseBody: pol.CaptureResponseBody,
		MaxPayloadBytes:     maxBytes,
		UpdatedBy:           &actor,
	})
	if err != nil {
		return Stored{}, fmt.Errorf("capture: upsert policy: %w", err)
	}
	saved := fromRow(row.Enabled, row.SampleRate, row.CaptureHeaders, row.CaptureRequestBody, row.CaptureResponseBody, row.MaxPayloadBytes)
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &actor,
		Actor: &actor,
		Kind:  audit.CapturePolicyUpdated,
		Meta:  policyMeta(app, saved),
	}); err != nil {
		return Stored{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Stored{}, fmt.Errorf("capture: commit: %w", err)
	}
	return Stored{App: app, Policy: saved, UpdatedAt: &row.UpdatedAt, UpdatedBy: row.UpdatedBy}, nil
}

func lookupApp(ctx context.Context, q *db.Queries, id uuid.UUID) (App, error) {
	row, err := q.GetCaptureApp(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return App{}, ErrUnknownApp
	}
	if err != nil {
		return App{}, fmt.Errorf("capture: get app: %w", err)
	}
	return App{ID: row.ID, Slug: row.Slug, ProjectID: row.ProjectID, ProjectSlug: row.ProjectSlug, OrgID: row.OrgID}, nil
}

func fromRow(enabled bool, rate float64, headers, reqBody, respBody bool, maxBytes *int32) Policy {
	p := Policy{Enabled: enabled, SampleRate: rate, CaptureHeaders: headers, CaptureRequestBody: reqBody, CaptureResponseBody: respBody}
	if maxBytes != nil {
		v := int(*maxBytes)
		p.MaxPayloadBytes = &v
	}
	return p
}

// policyMeta is the audit metadata of a policy change: the new values.
func policyMeta(app App, p Policy) map[string]any {
	m := map[string]any{
		"org_id":                app.OrgID.String(),
		"project_id":            app.ProjectID.String(),
		"project_slug":          app.ProjectSlug,
		"app_id":                app.ID.String(),
		"app_slug":              app.Slug,
		"enabled":               p.Enabled,
		"sample_rate":           p.SampleRate,
		"capture_headers":       p.CaptureHeaders,
		"capture_request_body":  p.CaptureRequestBody,
		"capture_response_body": p.CaptureResponseBody,
		"max_payload_bytes":     nil,
	}
	if p.MaxPayloadBytes != nil {
		m["max_payload_bytes"] = *p.MaxPayloadBytes
	}
	return m
}
