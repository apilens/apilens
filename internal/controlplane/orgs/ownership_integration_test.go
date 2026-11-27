//go:build integration

package orgs

import (
	"context"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestSoleOwnedOrgsIntegration checks the account-deletion guard against
// Postgres: only an organization whose single live owner is the user blocks
// their deletion.
func TestSoleOwnedOrgsIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	svc := New(pool, audit.New(pool))
	own := NewOwnership(pool)

	user := func(email string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, id, email); err != nil {
			t.Fatal(err)
		}
		return id
	}
	org := func(owner uuid.UUID, slug string) uuid.UUID {
		t.Helper()
		o, err := svc.Create(ctx, owner, slug, slug)
		if err != nil {
			t.Fatal(err)
		}
		return o.ID
	}
	soleOwned := func(u uuid.UUID) []uuid.UUID {
		t.Helper()
		got, err := own.SoleOwnedOrgs(ctx, u)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	t.Run("the only owner is blocked", func(t *testing.T) {
		ada := user("sole-ada@example.com")
		id := org(ada, "sole-acme")
		if got := soleOwned(ada); !slices.Equal(got, []uuid.UUID{id}) {
			t.Fatalf("sole owned = %v, want [%v]", got, id)
		}
	})

	t.Run("a second owner frees both", func(t *testing.T) {
		ada := user("two-ada@example.com")
		bob := user("two-bob@example.com")
		id := org(ada, "two-acme")
		if _, err := pool.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, id, bob); err != nil {
			t.Fatal(err)
		}
		if got := soleOwned(ada); len(got) != 0 {
			t.Fatalf("sole owned = %v, want none", got)
		}
		if got := soleOwned(bob); len(got) != 0 {
			t.Fatalf("sole owned = %v, want none", got)
		}
	})

	t.Run("a co-owner with a deleted account does not count", func(t *testing.T) {
		ada := user("gone-ada@example.com")
		bob := user("gone-bob@example.com")
		id := org(ada, "gone-acme")
		if _, err := pool.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, id, bob); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, bob); err != nil {
			t.Fatal(err)
		}
		if got := soleOwned(ada); !slices.Equal(got, []uuid.UUID{id}) {
			t.Fatalf("sole owned = %v, want [%v]", got, id)
		}
	})

	t.Run("a soft-deleted organization never blocks", func(t *testing.T) {
		ada := user("deleted-org-ada@example.com")
		id := org(ada, "deleted-acme")
		if _, err := pool.Exec(ctx, `UPDATE organizations SET deleted_at = now() WHERE id = $1`, id); err != nil {
			t.Fatal(err)
		}
		if got := soleOwned(ada); len(got) != 0 {
			t.Fatalf("sole owned = %v, want none for a deleted organization", got)
		}
	})

	t.Run("a member who is not an owner is free", func(t *testing.T) {
		ada := user("member-ada@example.com")
		mia := user("member-mia@example.com")
		id := org(ada, "member-acme")
		if _, err := pool.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`, id, mia); err != nil {
			t.Fatal(err)
		}
		if got := soleOwned(mia); len(got) != 0 {
			t.Fatalf("sole owned = %v, want none", got)
		}
	})
}
