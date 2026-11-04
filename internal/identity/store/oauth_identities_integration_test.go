//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestOAuthIdentities(t *testing.T) {
	ctx := context.Background()
	q := db.New(testutil.MigratedPostgres(t))

	ada, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	bob, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "bob@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	email := "ada@example.com"
	now := time.Now()

	google, err := q.CreateOAuthIdentity(ctx, db.CreateOAuthIdentityParams{
		ID: uuid.New(), UserID: ada.ID, Provider: "google", Subject: "1098765", Email: &email,
		Profile: []byte(`{"name":"Ada"}`), LastLoginAt: &now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if google.UserID != ada.ID || google.Email == nil || *google.Email != email || google.LastLoginAt == nil ||
		string(google.Profile) != `{"name": "Ada"}` {
		t.Fatalf("created: %+v (profile %s)", google, google.Profile)
	}
	github, err := q.CreateOAuthIdentity(ctx, db.CreateOAuthIdentityParams{
		ID: uuid.New(), UserID: ada.ID, Provider: "github", Subject: "42", Profile: []byte(`{}`),
	})
	if err != nil {
		t.Fatalf("second provider for one user: %v", err)
	}
	if github.Email != nil || github.LastLoginAt != nil {
		t.Fatalf("optional fields should be NULL: %+v", github)
	}

	t.Run("a provider account maps to one user", func(t *testing.T) {
		if _, err := q.CreateOAuthIdentity(ctx, db.CreateOAuthIdentityParams{
			ID: uuid.New(), UserID: bob.ID, Provider: "github", Subject: "42", Profile: []byte(`{}`),
		}); err == nil {
			t.Fatal("linking an already linked (provider, subject) should fail")
		}
		if _, err := q.CreateOAuthIdentity(ctx, db.CreateOAuthIdentityParams{
			ID: uuid.New(), UserID: bob.ID, Provider: "gitlab", Subject: "7", Profile: []byte(`{}`),
		}); err == nil {
			t.Fatal("unknown provider should be rejected")
		}
	})

	t.Run("get by provider and subject", func(t *testing.T) {
		got, err := q.GetOAuthIdentityByProviderSubject(ctx, db.GetOAuthIdentityByProviderSubjectParams{Provider: "github", Subject: "42"})
		if err != nil || got.ID != github.ID || got.UserID != ada.ID {
			t.Fatalf("got %+v %v", got, err)
		}
		if _, err := q.GetOAuthIdentityByProviderSubject(ctx, db.GetOAuthIdentityByProviderSubjectParams{Provider: "google", Subject: "42"}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("subject under another provider: want ErrNoRows, got %v", err)
		}
	})

	t.Run("list and count for user", func(t *testing.T) {
		list, err := q.ListOAuthIdentitiesForUser(ctx, ada.ID)
		if err != nil || len(list) != 2 || list[0].ID != google.ID || list[1].ID != github.ID {
			t.Fatalf("list: %+v %v", list, err)
		}
		if n, err := q.CountOAuthIdentitiesForUser(ctx, ada.ID); err != nil || n != 2 {
			t.Fatalf("count: %d %v", n, err)
		}
		empty, err := q.ListOAuthIdentitiesForUser(ctx, bob.ID)
		if err != nil || empty == nil || len(empty) != 0 {
			t.Fatalf("list for user without identities: %#v %v", empty, err)
		}
		if n, err := q.CountOAuthIdentitiesForUser(ctx, bob.ID); err != nil || n != 0 {
			t.Fatalf("count for user without identities: %d %v", n, err)
		}
	})

	t.Run("delete is scoped to the user", func(t *testing.T) {
		if n, err := q.DeleteOAuthIdentity(ctx, db.DeleteOAuthIdentityParams{ID: github.ID, UserID: bob.ID}); err != nil || n != 0 {
			t.Fatalf("another user's delete: %d %v; want 0", n, err)
		}
		if n, err := q.DeleteOAuthIdentity(ctx, db.DeleteOAuthIdentityParams{ID: github.ID, UserID: ada.ID}); err != nil || n != 1 {
			t.Fatalf("delete: %d %v; want 1", n, err)
		}
		if n, err := q.CountOAuthIdentitiesForUser(ctx, ada.ID); err != nil || n != 1 {
			t.Fatalf("count after delete: %d %v", n, err)
		}
		// Once unlinked, the provider account can be linked to someone else.
		if _, err := q.CreateOAuthIdentity(ctx, db.CreateOAuthIdentityParams{
			ID: uuid.New(), UserID: bob.ID, Provider: "github", Subject: "42", Profile: []byte(`{}`),
		}); err != nil {
			t.Fatalf("relink after delete: %v", err)
		}
	})
}
