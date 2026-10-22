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
	// APIKey (scope "ingest") goes into SDKs and OTLP exporters.
	APIKey string `json:"api_key"`
	// ReadKey (scope "read") lets the console and scripts query data. It
	// stands in for user sessions until identity arrives in M2.
	ReadKey string `json:"read_key"`
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
		ingestKey, err := issueKey(ctx, q, project.ID, o.KeyName, "ingest")
		if err != nil {
			return err
		}
		readKey, err := issueKey(ctx, q, project.ID, o.KeyName+"-read", "read")
		if err != nil {
			return err
		}
		res = Result{
			OrgID: org.ID, ProjectID: project.ID, ProjectSlug: project.Slug, AppID: app.ID, AppSlug: app.Slug,
			Environment: o.Environment, APIKey: ingestKey, ReadKey: readKey,
		}
		return nil
	})
	return res, err
}

// issueKey creates a single-scope key and returns its raw value.
func issueKey(ctx context.Context, q *db.Queries, projectID uuid.UUID, name, scope string) (string, error) {
	raw, prefix, hash, err := apikeys.Generate()
	if err != nil {
		return "", err
	}
	if _, err := q.CreateAPIKey(ctx, db.CreateAPIKeyParams{
		ID: newID(), ProjectID: projectID, Name: name, Prefix: prefix, KeyHash: hash, Scopes: []string{scope},
	}); err != nil {
		return "", fmt.Errorf("%s key: %w", scope, err)
	}
	return raw, nil
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
