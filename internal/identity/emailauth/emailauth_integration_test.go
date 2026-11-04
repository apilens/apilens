//go:build integration

package emailauth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/testutil"
)

func TestEmailAuthPostgres(t *testing.T) {
	ctx := context.Background()
	store := emailauth.NewStore(testutil.MigratedPostgres(t))
	s := emailauth.New(store, emailauth.Options{})
	const addr = "ada@example.com"
	next := "/projects/demo"

	issue := func(t *testing.T) emailauth.Issued {
		t.Helper()
		is, err := s.Issue(ctx, addr, emailauth.IntentSignIn, emailauth.IssueOptions{NextPath: &next})
		if err != nil {
			t.Fatal(err)
		}
		return is
	}
	wrong := func(code string) string {
		if code == "000000" {
			return "000001"
		}
		return "000000"
	}

	t.Run("link is single use and consumes the code", func(t *testing.T) {
		is := issue(t)
		row, err := s.VerifyLink(ctx, is.LinkToken)
		if err != nil || row.ID != is.Row.ID || row.ConsumedAt == nil || row.NextPath == nil || *row.NextPath != next {
			t.Fatalf("verify link: %+v %v", row, err)
		}
		if _, err := s.VerifyLink(ctx, is.LinkToken); !errors.Is(err, emailauth.ErrInvalidLink) {
			t.Fatalf("reuse: %v", err)
		}
		if _, err := s.VerifyCode(ctx, addr, is.Code); !errors.Is(err, emailauth.ErrInvalidCode) {
			t.Fatalf("code after link: %v", err)
		}
	})

	t.Run("new email invalidates the old one", func(t *testing.T) {
		old := issue(t)
		fresh := issue(t)
		if _, err := s.VerifyLink(ctx, old.LinkToken); !errors.Is(err, emailauth.ErrInvalidLink) {
			t.Fatalf("old link: %v", err)
		}
		if row, err := s.VerifyCode(ctx, "ADA@example.com", fresh.Code); err != nil || row.ID != fresh.Row.ID {
			t.Fatalf("fresh code: %+v %v", row, err)
		}
	})

	t.Run("attempts lock out the code", func(t *testing.T) {
		is := issue(t)
		for i := 1; i < emailauth.MaxAttempts; i++ {
			if _, err := s.VerifyCode(ctx, addr, wrong(is.Code)); !errors.Is(err, emailauth.ErrInvalidCode) {
				t.Fatalf("guess %d: %v", i, err)
			}
		}
		if _, err := s.VerifyCode(ctx, addr, wrong(is.Code)); !errors.Is(err, emailauth.ErrTooManyAttempts) {
			t.Fatalf("last guess: %v", err)
		}
		if _, err := s.VerifyCode(ctx, addr, is.Code); !errors.Is(err, emailauth.ErrTooManyAttempts) {
			t.Fatalf("right code after lockout: %v", err)
		}
	})

	t.Run("expired code and link", func(t *testing.T) {
		late := emailauth.New(store, emailauth.Options{
			Now: func() time.Time { return time.Now().Add(-emailauth.TTL - time.Minute) },
		})
		is, err := late.Issue(ctx, addr, emailauth.IntentSignIn, emailauth.IssueOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.VerifyCode(ctx, addr, wrong(is.Code)); !errors.Is(err, emailauth.ErrInvalidCode) {
			t.Fatalf("wrong expired code: %v", err)
		}
		if _, err := s.VerifyCode(ctx, addr, is.Code); !errors.Is(err, emailauth.ErrCodeExpired) {
			t.Fatalf("expired code: %v", err)
		}
		if _, err := s.VerifyLink(ctx, is.LinkToken); !errors.Is(err, emailauth.ErrLinkExpired) {
			t.Fatalf("expired link: %v", err)
		}
	})
}
