//go:build integration

package orgs

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestJoinViaSSOIntegration checks the just-in-time membership of an SSO
// sign-in against Postgres: the membership and its outbox row commit
// together, an existing member keeps their role, and owner is never granted.
func TestJoinViaSSOIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	svc := New(pool, audit.New(pool))
	user := func(email string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, id, email); err != nil {
			t.Fatal(err)
		}
		return id
	}
	owner := user("sso-owner@example.com")
	ada := user("ada@acme.example.com")
	org, err := svc.Create(ctx, owner, "Acme", "acme-sso")
	if err != nil {
		t.Fatal(err)
	}
	role := func(u uuid.UUID) string {
		t.Helper()
		var r string
		if err := pool.QueryRow(ctx, `SELECT coalesce((SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2), '')`, org.ID, u).Scan(&r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	upserts := func(u uuid.UUID) []map[string]any {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT payload FROM outbox WHERE topic = 'membership.upserted' AND aggregate_id = $1 AND payload->>'user_id' = $2 ORDER BY id`, org.ID.String(), u.String())
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []map[string]any
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatal(err)
			}
			out = append(out, m)
		}
		return out
	}

	joined, err := svc.JoinViaSSO(ctx, org.ID, ada, RoleViewer)
	if err != nil || !joined {
		t.Fatalf("join = %v, %v", joined, err)
	}
	if r := role(ada); r != RoleViewer {
		t.Fatalf("role = %q", r)
	}
	if ev := upserts(ada); len(ev) != 1 || ev[0]["role"] != RoleViewer || ev[0]["org_id"] != org.ID.String() {
		t.Fatalf("outbox = %v", ev)
	}

	// Already a member: nothing changes, no outbox row.
	if _, err := pool.Exec(ctx, `UPDATE memberships SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, org.ID, ada); err != nil {
		t.Fatal(err)
	}
	joined, err = svc.JoinViaSSO(ctx, org.ID, ada, RoleMember)
	if err != nil || joined {
		t.Fatalf("second join = %v, %v", joined, err)
	}
	if r := role(ada); r != RoleAdmin || len(upserts(ada)) != 1 {
		t.Fatalf("role = %q, outbox rows = %d", r, len(upserts(ada)))
	}
	if joined, err := svc.JoinViaSSO(ctx, org.ID, owner, RoleMember); err != nil || joined || role(owner) != RoleOwner {
		t.Fatalf("owner join = %v, %v", joined, err)
	}

	// SSO never grants owner, nor an unknown role.
	bob := user("bob@acme.example.com")
	for _, r := range []string{RoleOwner, "superuser"} {
		if _, err := svc.JoinViaSSO(ctx, org.ID, bob, r); !errors.Is(err, ErrInvalid) {
			t.Fatalf("join as %s: %v", r, err)
		}
	}
	if role(bob) != "" || len(upserts(bob)) != 0 {
		t.Fatal("refused join wrote a membership")
	}
}
