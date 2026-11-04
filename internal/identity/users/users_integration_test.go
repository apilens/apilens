//go:build integration

package users_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/testutil"
)

func TestFindOrCreateByVerifiedEmailIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	svc := users.New(pool)

	// createdMethods returns the method of each user.created event the user
	// recorded about themself.
	createdMethods := func(t *testing.T, user uuid.UUID) []string {
		t.Helper()
		rows, err := pool.Query(ctx,
			`SELECT metadata->>'method' FROM audit_events WHERE user_id = $1 AND actor_user_id = $1 AND event = $2`,
			user, string(audit.UserCreated))
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var m string
			if err := rows.Scan(&m); err != nil {
				t.Fatal(err)
			}
			out = append(out, m)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}

	t.Run("first login bootstraps the user", func(t *testing.T) {
		before := time.Now().Add(-time.Second)
		u, isNew, err := svc.FindOrCreateByVerifiedEmail(ctx, "First@Example.com", users.SourceGoogle)
		if err != nil {
			t.Fatal(err)
		}
		if !isNew {
			t.Fatal("created = false for a new address")
		}
		stored, err := q.GetUserByID(ctx, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.EmailVerifiedAt == nil || stored.EmailVerifiedAt.Before(before) {
			t.Fatalf("email_verified_at = %v", stored.EmailVerifiedAt)
		}
		if stored.LastLoginAt == nil || stored.LastLoginAt.Before(before) {
			t.Fatalf("last_login_at = %v", stored.LastLoginAt)
		}
		var prefs, onboarding map[string]any
		if err := json.Unmarshal(stored.Preferences, &prefs); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(stored.Onboarding, &onboarding); err != nil {
			t.Fatal(err)
		}
		if len(prefs) != 1 || prefs["home"] != "endpoints" {
			t.Fatalf("preferences = %v", prefs)
		}
		if len(onboarding) != 1 || onboarding["step"] != "about" {
			t.Fatalf("onboarding = %v", onboarding)
		}
		if m := createdMethods(t, u.ID); len(m) != 1 || m[0] != "google" {
			t.Fatalf("user.created methods = %v, want [google]", m)
		}

		// The next login finds the same user, case-insensitively.
		again, isNew, err := svc.FindOrCreateByVerifiedEmail(ctx, "first@example.com", users.SourceEmail)
		if err != nil {
			t.Fatal(err)
		}
		if isNew || again.ID != u.ID {
			t.Fatalf("second login: created=%v id=%s, want the existing %s", isNew, again.ID, u.ID)
		}
		if m := createdMethods(t, u.ID); len(m) != 1 {
			t.Fatalf("user.created audited %d times", len(m))
		}
	})

	t.Run("existing unverified user is marked verified, not bootstrapped", func(t *testing.T) {
		existing, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "pending@example.com", Name: "Pending"})
		if err != nil {
			t.Fatal(err)
		}
		u, isNew, err := svc.FindOrCreateByVerifiedEmail(ctx, "pending@example.com", users.SourceGitHub)
		if err != nil {
			t.Fatal(err)
		}
		if isNew || u.ID != existing.ID || u.EmailVerifiedAt == nil || u.Name != "Pending" {
			t.Fatalf("user = %+v created=%v", u, isNew)
		}
		if string(u.Onboarding) != "{}" {
			t.Fatalf("onboarding of an existing user changed: %s", u.Onboarding)
		}
		if m := createdMethods(t, u.ID); len(m) != 0 {
			t.Fatalf("user.created audited for an existing user: %v", m)
		}
	})

	t.Run("deleted account's address signs up again", func(t *testing.T) {
		old, _, err := svc.FindOrCreateByVerifiedEmail(ctx, "gone@example.com", users.SourceEmail)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := q.SoftDeleteUser(ctx, db.SoftDeleteUserParams{ID: old.ID, DeleteAfter: time.Now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		u, isNew, err := svc.FindOrCreateByVerifiedEmail(ctx, "gone@example.com", users.SourceSSO)
		if err != nil {
			t.Fatal(err)
		}
		if !isNew || u.ID == old.ID {
			t.Fatalf("created=%v id=%s, want a new user", isNew, u.ID)
		}
		if m := createdMethods(t, u.ID); len(m) != 1 || m[0] != "sso" {
			t.Fatalf("user.created methods = %v, want [sso]", m)
		}
	})

	t.Run("concurrent first logins create one user", func(t *testing.T) {
		const n = 8
		var (
			wg    sync.WaitGroup
			start = make(chan struct{})
			ids   [n]uuid.UUID
			news  [n]bool
			errs  [n]error
		)
		for i := range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				u, isNew, err := svc.FindOrCreateByVerifiedEmail(ctx, "race@example.com", users.SourceEmail)
				ids[i], news[i], errs[i] = u.ID, isNew, err
			}()
		}
		close(start)
		wg.Wait()
		creators := 0
		for i := range n {
			if errs[i] != nil {
				t.Fatalf("login %d: %v", i, errs[i])
			}
			if ids[i] != ids[0] {
				t.Fatalf("login %d got user %s, login 0 got %s", i, ids[i], ids[0])
			}
			if news[i] {
				creators++
			}
		}
		if creators != 1 {
			t.Fatalf("%d logins reported created, want 1", creators)
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE lower(email) = 'race@example.com'`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("%d users for one address", count)
		}
		if m := createdMethods(t, ids[0]); len(m) != 1 {
			t.Fatalf("user.created audited %d times", len(m))
		}
	})
}
