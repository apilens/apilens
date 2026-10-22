// Package bootstrap creates the first organization, project, app,
// environment and ingest key. It backs `apilens seed` until the control-plane
// API and identity arrive in M2.
package bootstrap

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Options names the resources to create or reuse.
type Options struct {
	OrgSlug     string
	ProjectSlug string
	AppSlug     string
	Environment string
	KeyName     string
}

// Result is printed by `apilens seed`. APIKey is shown only once.
type Result struct {
	OrgID       uuid.UUID `json:"org_id"`
	ProjectID   uuid.UUID `json:"project_id"`
	ProjectSlug string    `json:"project_slug"`
	AppID       uuid.UUID `json:"app_id"`
	AppSlug     string    `json:"app_slug"`
	Environment string    `json:"environment"`
	APIKey      string    `json:"api_key"`
}

// Seed is idempotent for the org/project/app/environment and always issues a
// new key, all in one transaction.
func Seed(ctx context.Context, pool *pgxpool.Pool, o Options) (Result, error) {
	if o.KeyName == "" {
		o.KeyName = "seed"
	}
	var res Result
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		q := db.New(tx)
		org, err := q.UpsertOrganization(ctx, db.UpsertOrganizationParams{ID: newID(), Slug: o.OrgSlug, Name: title(o.OrgSlug)})
		if err != nil {
			return fmt.Errorf("organization: %w", err)
		}
		project, err := q.UpsertProject(ctx, db.UpsertProjectParams{ID: newID(), OrgID: org.ID, Slug: o.ProjectSlug, Name: title(o.ProjectSlug)})
		if err != nil {
			return fmt.Errorf("project: %w", err)
		}
		if project.OrgID != org.ID {
			return fmt.Errorf("project slug %q already belongs to another organization", o.ProjectSlug)
		}
		app, err := q.UpsertApp(ctx, db.UpsertAppParams{ID: newID(), ProjectID: project.ID, Slug: o.AppSlug, Name: title(o.AppSlug)})
		if err != nil {
			return fmt.Errorf("app: %w", err)
		}
		if _, err := q.UpsertEnvironment(ctx, db.UpsertEnvironmentParams{ID: newID(), ProjectID: project.ID, Name: o.Environment}); err != nil {
			return fmt.Errorf("environment: %w", err)
		}
		raw, prefix, hash, err := apikeys.Generate()
		if err != nil {
			return err
		}
		if _, err := q.CreateAPIKey(ctx, db.CreateAPIKeyParams{
			ID: newID(), ProjectID: project.ID, Name: o.KeyName, Prefix: prefix, KeyHash: hash, Scopes: []string{"ingest"},
		}); err != nil {
			return fmt.Errorf("api key: %w", err)
		}
		res = Result{OrgID: org.ID, ProjectID: project.ID, ProjectSlug: project.Slug, AppID: app.ID, AppSlug: app.Slug, Environment: o.Environment, APIKey: raw}
		return nil
	})
	return res, err
}

// newID returns a time-ordered UUIDv7 (better B-tree locality than v4).
func newID() uuid.UUID { return uuid.Must(uuid.NewV7()) }

func title(slug string) string {
	parts := strings.Split(slug, "-")
	for i, p := range parts {
		if p != "" {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}
