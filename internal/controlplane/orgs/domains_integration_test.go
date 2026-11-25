//go:build integration

package orgs

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestUpdateAllowedDomainsIntegration checks the join-domain rules against
// Postgres: a domain may only be added by someone whose own verified email is
// at it, and only one active organization may claim it.
func TestUpdateAllowedDomainsIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	svc := New(pool, audit.New(pool))

	user := func(email string, verified bool) uuid.UUID {
		t.Helper()
		id := uuid.New()
		at := "NULL"
		if verified {
			at = "now()"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, email_verified_at) VALUES ($1, $2, `+at+`)`, id, email); err != nil {
			t.Fatal(err)
		}
		return id
	}
	domains := func(v ...string) *[]string { return &v }

	ada := user("ada@acme.dev", true)
	acme, err := svc.Create(ctx, ada, "Acme", "acme-domains")
	if err != nil {
		t.Fatal(err)
	}

	t.Run("their own domain is accepted", func(t *testing.T) {
		got, err := svc.Update(ctx, ada, acme.Slug, Update{AllowedDomains: domains("acme.dev")})
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		if len(got.AllowedDomains) != 1 || got.AllowedDomains[0] != "acme.dev" {
			t.Fatalf("domains = %v", got.AllowedDomains)
		}
	})

	t.Run("someone else's domain is refused", func(t *testing.T) {
		var nv *DomainNotVerifiedError
		_, err := svc.Update(ctx, ada, acme.Slug, Update{AllowedDomains: domains("acme.dev", "globex.com")})
		if !errors.As(err, &nv) || nv.Domain != "globex.com" {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("an unverified email can add nothing", func(t *testing.T) {
		eli := user("eli@beta.dev", false)
		if _, err := pool.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')`, acme.ID, eli); err != nil {
			t.Fatal(err)
		}
		var nv *DomainNotVerifiedError
		_, err := svc.Update(ctx, eli, acme.Slug, Update{AllowedDomains: domains("acme.dev", "beta.dev")})
		if !errors.As(err, &nv) || nv.Domain != "beta.dev" {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("a domain already stored is kept without re-verifying", func(t *testing.T) {
		// acme.dev is stored; mia, whose email is elsewhere, may still save the list.
		mia := user("mia@other.dev", true)
		if _, err := pool.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')`, acme.ID, mia); err != nil {
			t.Fatal(err)
		}
		got, err := svc.Update(ctx, mia, acme.Slug, Update{AllowedDomains: domains("acme.dev"), DomainJoin: boolPtr(true)})
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		if !got.DomainJoin {
			t.Fatal("domain join not saved")
		}
	})

	t.Run("another organization cannot claim the same domain", func(t *testing.T) {
		bob := user("bob@acme.dev", true)
		other, err := svc.Create(ctx, bob, "Acme Side", "acme-side")
		if err != nil {
			t.Fatal(err)
		}
		var taken *DomainTakenError
		_, err = svc.Update(ctx, bob, other.Slug, Update{AllowedDomains: domains("acme.dev")})
		if !errors.As(err, &taken) || taken.Domain != "acme.dev" {
			t.Fatalf("err = %v", err)
		}

		// Once the first organization is gone, the domain is free again.
		if _, err := pool.Exec(ctx, `UPDATE organizations SET deleted_at = now() WHERE id = $1`, acme.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.Update(ctx, bob, other.Slug, Update{AllowedDomains: domains("acme.dev")}); err != nil {
			t.Fatalf("after the claim was released: %v", err)
		}
	})
}

func boolPtr(v bool) *bool { return &v }
