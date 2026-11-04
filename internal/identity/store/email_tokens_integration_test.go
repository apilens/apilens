//go:build integration

package store_test

import (
	"context"
	"errors"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestEmailTokens(t *testing.T) {
	ctx := context.Background()
	q := db.New(testutil.MigratedPostgres(t))

	user, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	ip := netip.MustParseAddr("203.0.113.7")
	next := "/projects/demo?tab=errors"
	expires := time.Now().Add(15 * time.Minute)

	issue := func(t *testing.T, email, linkHash string, expiresAt time.Time) db.AuthEmailToken {
		t.Helper()
		tok, err := q.CreateEmailToken(ctx, db.CreateEmailTokenParams{
			ID: uuid.New(), Email: email, Intent: "signin", UserID: &user.ID, LinkTokenHash: linkHash,
			CodeHash: "code-" + linkHash, NextPath: &next, Ip: &ip, UserAgent: "Mozilla/5.0", ExpiresAt: expiresAt,
		})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}

	first := issue(t, "ada@example.com", "link-1", expires)
	if first.Attempts != 0 || first.ConsumedAt != nil || first.UserID == nil || *first.UserID != user.ID ||
		first.NextPath == nil || *first.NextPath != next || first.Ip == nil || *first.Ip != ip {
		t.Fatalf("created: %+v", first)
	}

	t.Run("next_path must be relative", func(t *testing.T) {
		bad := "https://evil.example/"
		if _, err := q.CreateEmailToken(ctx, db.CreateEmailTokenParams{
			ID: uuid.New(), Email: "ada@example.com", Intent: "signin", LinkTokenHash: "link-bad",
			CodeHash: "c", NextPath: &bad, ExpiresAt: expires,
		}); err == nil {
			t.Fatal("absolute next_path should be rejected")
		}
	})

	t.Run("get by link hash", func(t *testing.T) {
		tok, err := q.GetEmailTokenByLinkHash(ctx, "link-1")
		if err != nil || tok.ID != first.ID {
			t.Fatalf("got %+v %v", tok, err)
		}
		if _, err := q.GetEmailTokenByLinkHash(ctx, "nope"); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("unknown hash: want ErrNoRows, got %v", err)
		}
	})

	t.Run("latest for email is case-insensitive and newest first", func(t *testing.T) {
		second := issue(t, "ADA@example.com", "link-2", expires)
		tok, err := q.GetLatestEmailTokenForEmail(ctx, "Ada@Example.com")
		if err != nil || tok.ID != second.ID {
			t.Fatalf("latest: %+v %v (want %s)", tok, err, second.ID)
		}
		if _, err := q.GetLatestEmailTokenForEmail(ctx, "nobody@example.com"); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("unknown email: want ErrNoRows, got %v", err)
		}
	})

	t.Run("increment attempts", func(t *testing.T) {
		for want := int32(1); want <= 3; want++ {
			n, err := q.IncrementEmailTokenAttempts(ctx, first.ID)
			if err != nil || n != want {
				t.Fatalf("attempts = %d, %v; want %d", n, err, want)
			}
		}
	})

	t.Run("invalidate retires every outstanding row of the address", func(t *testing.T) {
		n, err := q.InvalidateEmailTokensForEmail(ctx, "ada@EXAMPLE.com")
		if err != nil || n != 2 {
			t.Fatalf("invalidate: %d %v", n, err)
		}
		if _, err := q.GetLatestEmailTokenForEmail(ctx, "ada@example.com"); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("after invalidate: want ErrNoRows, got %v", err)
		}
		if _, err := q.ConsumeEmailToken(ctx, first.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("consuming an invalidated token: want ErrNoRows, got %v", err)
		}
		if _, err := q.IncrementEmailTokenAttempts(ctx, first.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("guessing on an invalidated token: want ErrNoRows, got %v", err)
		}
	})

	t.Run("consume succeeds once", func(t *testing.T) {
		third := issue(t, "ada@example.com", "link-3", expires)
		tok, err := q.ConsumeEmailToken(ctx, third.ID)
		if err != nil || tok.ConsumedAt == nil {
			t.Fatalf("consume: %+v %v", tok, err)
		}
		if _, err := q.ConsumeEmailToken(ctx, third.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("second consume: want ErrNoRows, got %v", err)
		}
		if n, err := q.InvalidateEmailTokensForEmail(ctx, "ada@example.com"); err != nil || n != 0 {
			t.Fatalf("invalidate must skip consumed rows: %d %v", n, err)
		}
	})

	t.Run("expired tokens are not live", func(t *testing.T) {
		old := issue(t, "late@example.com", "link-4", time.Now().Add(-time.Minute))
		if _, err := q.GetLatestEmailTokenForEmail(ctx, "late@example.com"); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("expired latest: want ErrNoRows, got %v", err)
		}
		if _, err := q.ConsumeEmailToken(ctx, old.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("consuming an expired token: want ErrNoRows, got %v", err)
		}
		if tok, err := q.GetEmailTokenByLinkHash(ctx, "link-4"); err != nil || tok.ID != old.ID {
			t.Fatalf("expired row must still be readable by link hash: %+v %v", tok, err)
		}
	})
}
