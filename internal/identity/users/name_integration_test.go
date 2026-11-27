//go:build integration

package users_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/testutil"
)

func TestSetNameIfEmptyIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	svc := users.New(pool)

	nameOf := func(t *testing.T, id uuid.UUID) string {
		t.Helper()
		u, err := q.GetUserByID(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return u.Name
	}

	t.Run("fills an empty name once", func(t *testing.T) {
		u, _, err := svc.FindOrCreateByVerifiedEmail(ctx, "ada@example.com", users.SourceGoogle)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.SetNameIfEmpty(ctx, u.ID, "Ada Lovelace"); err != nil {
			t.Fatal(err)
		}
		if err := svc.SetNameIfEmpty(ctx, u.ID, "Someone Else"); err != nil {
			t.Fatal(err)
		}
		if got := nameOf(t, u.ID); got != "Ada Lovelace" {
			t.Errorf("name = %q, want Ada Lovelace", got)
		}
	})

	t.Run("keeps an existing name", func(t *testing.T) {
		name := "Grace Hopper"
		u, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "grace@example.com", Name: name})
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.SetNameIfEmpty(ctx, u.ID, "Someone Else"); err != nil {
			t.Fatal(err)
		}
		if got := nameOf(t, u.ID); got != name {
			t.Errorf("name = %q, want %q", got, name)
		}
	})

	t.Run("ignores an empty name", func(t *testing.T) {
		u, _, err := svc.FindOrCreateByVerifiedEmail(ctx, "blank@example.com", users.SourceGitHub)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.SetNameIfEmpty(ctx, u.ID, ""); err != nil {
			t.Fatal(err)
		}
		if got := nameOf(t, u.ID); got != "" {
			t.Errorf("name = %q, want empty", got)
		}
	})
}
