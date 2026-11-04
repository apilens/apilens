//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestOrgSSOConnections(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)

	acme, other, gone := uuid.New(), uuid.New(), uuid.New()
	for _, org := range []struct {
		id   uuid.UUID
		slug string
	}{{acme, "acme"}, {other, "other"}, {gone, "gone"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)`, org.id, org.slug); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := q.GetOrgSSOConnection(ctx, acme); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("no connection yet: want ErrNoRows, got %v", err)
	}
	if _, err := q.GetOrgSSOConnectionForDomain(ctx, "acme.com"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("no domain yet: want ErrNoRows, got %v", err)
	}

	insert := `INSERT INTO org_sso_connections (org_id, issuer, client_id, client_secret_enc, domains, enforce)
		VALUES ($1, 'https://idp.example.com', 'client', '\x01', $2, $3)`
	if _, err := pool.Exec(ctx, insert, other, []string{"acme.com"}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, acme, []string{"acme.com", "acme.io"}, true); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, gone, []string{"gone.com"}, true); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE organizations SET deleted_at = now() WHERE id = $1`, gone); err != nil {
		t.Fatal(err)
	}

	got, err := q.GetOrgSSOConnection(ctx, acme)
	if err != nil || got.Issuer != "https://idp.example.com" || got.DefaultRole != "member" || got.LastLoginAt != nil {
		t.Fatalf("get: %+v %v", got, err)
	}
	byDomain, err := q.GetOrgSSOConnectionForDomain(ctx, "acme.com")
	if err != nil || byDomain.OrgID != acme || !byDomain.Enforce {
		t.Fatalf("an enforcing connection should win the domain lookup: %+v %v", byDomain, err)
	}
	if byDomain, err := q.GetOrgSSOConnectionForDomain(ctx, "acme.io"); err != nil || byDomain.OrgID != acme {
		t.Fatalf("second domain: %+v %v", byDomain, err)
	}
	if _, err := q.GetOrgSSOConnectionForDomain(ctx, "gone.com"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a deleted organization's domain: want ErrNoRows, got %v", err)
	}

	if err := q.TouchOrgSSOLastLogin(ctx, acme); err != nil {
		t.Fatal(err)
	}
	if got, err := q.GetOrgSSOConnection(ctx, acme); err != nil || got.LastLoginAt == nil {
		t.Fatalf("last_login_at after touch: %+v %v", got, err)
	}
}
