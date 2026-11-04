//go:build integration

package store_test

import (
	"context"
	"errors"
	"net/netip"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestSessions(t *testing.T) {
	ctx := context.Background()
	q := db.New(testutil.MigratedPostgres(t))

	user, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "grace@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "linus@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	ip := netip.MustParseAddr("203.0.113.7")
	expires := time.Now().Add(24 * time.Hour)

	signIn := func(t *testing.T, userID uuid.UUID, hash string) db.Session {
		t.Helper()
		id := uuid.New()
		s, err := q.CreateSession(ctx, db.CreateSessionParams{
			ID: id, UserID: userID, FamilyID: id, TokenHash: hash, Remember: true,
			Amr: []string{"otp", "mfa"}, Ip: &ip, UserAgent: "Mozilla/5.0", DeviceLabel: "Firefox on macOS", ExpiresAt: expires,
		})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}

	first := signIn(t, user.ID, "hash-1")
	if first.FamilyID != first.ID || first.ParentID != nil || first.RevokedAt != nil ||
		!slices.Equal(first.Amr, []string{"otp", "mfa"}) || first.Ip == nil || *first.Ip != ip {
		t.Fatalf("created: %+v", first)
	}

	t.Run("get by token hash", func(t *testing.T) {
		s, err := q.GetSessionByTokenHash(ctx, "hash-1")
		if err != nil || s.ID != first.ID {
			t.Fatalf("got %+v %v", s, err)
		}
		if _, err := q.GetSessionByTokenHash(ctx, "nope"); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("unknown hash: want ErrNoRows, got %v", err)
		}
	})

	var child db.Session
	t.Run("rotate revokes the parent and inherits from it", func(t *testing.T) {
		newIP := netip.MustParseAddr("198.51.100.1")
		child, err = q.RotateSession(ctx, db.RotateSessionParams{
			ID: uuid.New(), ParentID: first.ID, TokenHash: "hash-2", Ip: &newIP, UserAgent: "Mozilla/5.1", ExpiresAt: expires,
		})
		if err != nil {
			t.Fatal(err)
		}
		if child.FamilyID != first.FamilyID || child.UserID != user.ID || child.ParentID == nil || *child.ParentID != first.ID ||
			!child.Remember || !slices.Equal(child.Amr, first.Amr) || child.DeviceLabel != "Firefox on macOS" ||
			!child.CreatedAt.Equal(first.CreatedAt) || *child.Ip != newIP || child.UserAgent != "Mozilla/5.1" {
			t.Fatalf("child: %+v", child)
		}
		parent, err := q.GetSessionByTokenHash(ctx, "hash-1")
		if err != nil || parent.RevokedAt == nil || parent.RevokedReason == nil || *parent.RevokedReason != "rotated" {
			t.Fatalf("parent after rotation: %+v %v", parent, err)
		}
		// Rotating the same parent again (token reuse) finds no live row.
		if _, err := q.RotateSession(ctx, db.RotateSessionParams{
			ID: uuid.New(), ParentID: first.ID, TokenHash: "hash-3", UserAgent: "x", ExpiresAt: expires,
		}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("re-rotating a revoked parent: want ErrNoRows, got %v", err)
		}
	})

	t.Run("touch and list", func(t *testing.T) {
		second := signIn(t, user.ID, "hash-b1")
		_ = signIn(t, other.ID, "hash-o1")
		n, err := q.TouchSession(ctx, db.TouchSessionParams{ID: child.ID})
		if err != nil || n != 1 {
			t.Fatalf("touch: %d %v", n, err)
		}
		if n, err := q.TouchSession(ctx, db.TouchSessionParams{ID: first.ID}); err != nil || n != 0 {
			t.Fatalf("touching a revoked session: %d %v", n, err)
		}
		list, err := q.ListActiveSessionsForUser(ctx, user.ID)
		if err != nil || len(list) != 2 || list[0].ID != child.ID || list[1].ID != second.ID {
			t.Fatalf("list: %+v %v", list, err)
		}
		if list[0].Ip == nil || *list[0].Ip != netip.MustParseAddr("198.51.100.1") {
			t.Fatalf("touch with NULL ip must keep the stored ip: %+v", list[0])
		}
	})

	t.Run("revoke session is scoped to its user", func(t *testing.T) {
		third := signIn(t, user.ID, "hash-c1")
		if n, err := q.RevokeSession(ctx, db.RevokeSessionParams{ID: third.ID, UserID: other.ID, Reason: "logout"}); err != nil || n != 0 {
			t.Fatalf("other user's revoke: %d %v", n, err)
		}
		if n, err := q.RevokeSession(ctx, db.RevokeSessionParams{ID: third.ID, UserID: user.ID, Reason: "logout"}); err != nil || n != 1 {
			t.Fatalf("revoke: %d %v", n, err)
		}
		s, err := q.GetSessionByTokenHash(ctx, "hash-c1")
		if err != nil || s.RevokedReason == nil || *s.RevokedReason != "logout" {
			t.Fatalf("revoked: %+v %v", s, err)
		}
	})

	t.Run("revoke family", func(t *testing.T) {
		n, err := q.RevokeFamily(ctx, db.RevokeFamilyParams{FamilyID: first.FamilyID, Reason: "reuse_detected"})
		if err != nil || n != 1 {
			t.Fatalf("revoke family: %d %v", n, err)
		}
		s, err := q.GetSessionByTokenHash(ctx, "hash-2")
		if err != nil || s.RevokedReason == nil || *s.RevokedReason != "reuse_detected" {
			t.Fatalf("child after family revoke: %+v %v", s, err)
		}
		s, err = q.GetSessionByTokenHash(ctx, "hash-1")
		if err != nil || *s.RevokedReason != "rotated" {
			t.Fatalf("already-revoked rows keep their reason: %+v %v", s, err)
		}
	})

	t.Run("revoke others keeps the current family", func(t *testing.T) {
		keep := signIn(t, user.ID, "hash-d1")
		n, err := q.RevokeOthersForUser(ctx, db.RevokeOthersForUserParams{UserID: user.ID, KeepFamilyID: keep.FamilyID, Reason: "logout_others"})
		if err != nil || n != 1 { // hash-b1
			t.Fatalf("revoke others: %d %v", n, err)
		}
		list, err := q.ListActiveSessionsForUser(ctx, user.ID)
		if err != nil || len(list) != 1 || list[0].ID != keep.ID {
			t.Fatalf("after revoke others: %+v %v", list, err)
		}
	})

	t.Run("revoke all", func(t *testing.T) {
		n, err := q.RevokeAllForUser(ctx, db.RevokeAllForUserParams{UserID: user.ID, Reason: "logout_all"})
		if err != nil || n != 1 {
			t.Fatalf("revoke all: %d %v", n, err)
		}
		list, err := q.ListActiveSessionsForUser(ctx, user.ID)
		if err != nil || len(list) != 0 {
			t.Fatalf("after revoke all: %+v %v", list, err)
		}
		if list, err := q.ListActiveSessionsForUser(ctx, other.ID); err != nil || len(list) != 1 {
			t.Fatalf("other user's sessions must be untouched: %+v %v", list, err)
		}
	})

	t.Run("expired sessions are not live", func(t *testing.T) {
		id := uuid.New()
		if _, err := q.CreateSession(ctx, db.CreateSessionParams{
			ID: id, UserID: user.ID, FamilyID: id, TokenHash: "hash-e1", Amr: []string{}, ExpiresAt: time.Now().Add(-time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
		if list, err := q.ListActiveSessionsForUser(ctx, user.ID); err != nil || len(list) != 0 {
			t.Fatalf("expired session listed: %+v %v", list, err)
		}
		if _, err := q.RotateSession(ctx, db.RotateSessionParams{
			ID: uuid.New(), ParentID: id, TokenHash: "hash-e2", ExpiresAt: expires,
		}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("rotating an expired session: want ErrNoRows, got %v", err)
		}
	})
}
