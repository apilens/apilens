//go:build integration

package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestUsersAndAuditEvents(t *testing.T) {
	ctx := context.Background()
	q := db.New(testutil.MigratedPostgres(t))

	created, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "Ada@Example.COM", Name: "Ada"})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("get by email is case-insensitive", func(t *testing.T) {
		for _, email := range []string{"ada@example.com", "ADA@EXAMPLE.COM", "Ada@Example.COM"} {
			u, err := q.GetUserByEmail(ctx, email)
			if err != nil {
				t.Fatalf("%s: %v", email, err)
			}
			if u.ID != created.ID || u.Email != "Ada@Example.COM" {
				t.Fatalf("%s: got %+v", email, u)
			}
		}
		if _, err := q.GetUserByEmail(ctx, "other@example.com"); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("unknown email: want ErrNoRows, got %v", err)
		}
	})

	t.Run("email is unique among active users", func(t *testing.T) {
		_, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ADA@example.com"})
		if err == nil {
			t.Fatal("duplicate email (different case) should violate users_email_active")
		}
	})

	t.Run("profile, preferences, onboarding and last login", func(t *testing.T) {
		name := "Ada Lovelace"
		u, err := q.UpdateUserProfile(ctx, db.UpdateUserProfileParams{ID: created.ID, Name: &name})
		if err != nil || u.Name != name || u.AvatarUrl != "" {
			t.Fatalf("profile: %+v %v", u, err)
		}
		if _, err := q.UpdateUserPreferences(ctx, db.UpdateUserPreferencesParams{ID: created.ID, Patch: []byte(`{"theme":"dark","tz":"UTC"}`)}); err != nil {
			t.Fatal(err)
		}
		u, err = q.UpdateUserPreferences(ctx, db.UpdateUserPreferencesParams{ID: created.ID, Patch: []byte(`{"theme":"light"}`)})
		if err != nil {
			t.Fatal(err)
		}
		var prefs map[string]string
		if err := json.Unmarshal(u.Preferences, &prefs); err != nil || prefs["theme"] != "light" || prefs["tz"] != "UTC" {
			t.Fatalf("preferences should shallow-merge: %s %v", u.Preferences, err)
		}
		u, err = q.UpdateUserOnboarding(ctx, db.UpdateUserOnboardingParams{ID: created.ID, Patch: []byte(`{"step":"project"}`)})
		if err != nil || string(u.Onboarding) != `{"step": "project"}` {
			t.Fatalf("onboarding: %s %v", u.Onboarding, err)
		}
		if err := q.TouchLastLogin(ctx, created.ID); err != nil {
			t.Fatal(err)
		}
		u, err = q.GetUserByID(ctx, created.ID)
		if err != nil || u.LastLoginAt == nil {
			t.Fatalf("last login not set: %+v %v", u, err)
		}
	})

	t.Run("audit events", func(t *testing.T) {
		ip := netip.MustParseAddr("203.0.113.7")
		for _, ev := range []string{"user.signed_up", "user.signed_in", "user.profile_updated"} {
			if _, err := q.InsertAuditEvent(ctx, db.InsertAuditEventParams{
				UserID: &created.ID, ActorUserID: &created.ID, Event: ev, Ip: &ip, UserAgent: "test", Metadata: []byte(`{}`),
			}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := q.InsertAuditEvent(ctx, db.InsertAuditEventParams{Event: "system.anonymous", Metadata: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		page, err := q.ListAuditEventsForUser(ctx, db.ListAuditEventsForUserParams{UserID: created.ID, PageSize: 2})
		if err != nil || len(page) != 2 || page[0].Event != "user.profile_updated" || page[1].Event != "user.signed_in" {
			t.Fatalf("first page: %+v %v", page, err)
		}
		last := page[len(page)-1]
		page, err = q.ListAuditEventsForUser(ctx, db.ListAuditEventsForUserParams{
			UserID: created.ID, BeforeCreatedAt: &last.CreatedAt, BeforeID: &last.ID, PageSize: 2,
		})
		if err != nil || len(page) != 1 || page[0].Event != "user.signed_up" || page[0].Ip == nil || *page[0].Ip != ip {
			t.Fatalf("second page: %+v %v", page, err)
		}
	})

	t.Run("soft delete hides the user and frees the email; restore undoes it", func(t *testing.T) {
		deleteAfter := time.Now().Add(30 * 24 * time.Hour)
		u, err := q.SoftDeleteUser(ctx, db.SoftDeleteUserParams{ID: created.ID, DeleteAfter: deleteAfter})
		if err != nil || u.DeletedAt == nil || u.DeleteAfter == nil {
			t.Fatalf("soft delete: %+v %v", u, err)
		}
		if _, err := q.GetUserByID(ctx, created.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("deleted user by id: want ErrNoRows, got %v", err)
		}
		if _, err := q.GetUserByEmail(ctx, "ada@example.com"); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("deleted user by email: want ErrNoRows, got %v", err)
		}
		u, err = q.RestoreUser(ctx, created.ID)
		if err != nil || u.DeletedAt != nil || u.DeleteAfter != nil {
			t.Fatalf("restore: %+v %v", u, err)
		}
		if _, err := q.RestoreUser(ctx, created.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("restoring an active user: want ErrNoRows, got %v", err)
		}
		if _, err := q.GetUserByEmail(ctx, "ADA@example.com"); err != nil {
			t.Fatal(err)
		}
	})
}
