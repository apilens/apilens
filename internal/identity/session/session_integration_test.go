//go:build integration

package session_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"log/slog"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/testutil"
)

const (
	refreshTTL      = 720 * time.Hour
	refreshTTLShort = 24 * time.Hour
)

type keySet []keys.Key

func (s keySet) Active() (keys.Key, bool) { return keys.Active(s) }
func (s keySet) All() []keys.Key          { return s }

type fixture struct {
	pool   *pgxpool.Pool
	q      *db.Queries
	svc    *session.Service
	issuer *token.Issuer
	logs   *syncBuffer
	user   db.User
	ctx    context.Context
}

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func setup(t *testing.T) *fixture {
	t.Helper()
	pool := testutil.MigratedPostgres(t)
	priv, err := rsa.GenerateKey(rand.Reader, keys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	k, err := keys.Unstored(priv, &now, nil)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := token.New(keySet{k}, token.Options{Issuer: "https://id.example.com", TTL: 15 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	svc, err := session.New(pool, issuer, session.Options{RefreshTTL: refreshTTL, RefreshTTLShort: refreshTTLShort}, logger)
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(pool)
	ctx := audit.WithRequest(context.Background(), audit.Request{IP: netip.MustParseAddr("203.0.113.7"), UserAgent: "itest/1.0"})
	user, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ada@example.com", Name: "Ada"})
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{pool: pool, q: q, svc: svc, issuer: issuer, logs: logs, user: user, ctx: ctx}
}

func (f *fixture) create(t *testing.T, remember bool) session.Tokens {
	t.Helper()
	tok, err := f.svc.Create(f.ctx, f.user, remember, session.Meta{AMR: []string{token.AMREmail}, DeviceLabel: "Firefox on macOS"})
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// checkAccess verifies the access token and that its sid is the session row.
func (f *fixture) checkAccess(t *testing.T, tok session.Tokens) {
	t.Helper()
	claims, err := f.issuer.Verify(tok.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	if claims.SessionID != tok.Session.ID.String() || claims.Subject != f.user.ID.String() {
		t.Fatalf("claims sid=%s sub=%s, want sid=%s sub=%s", claims.SessionID, claims.Subject, tok.Session.ID, f.user.ID)
	}
	if len(claims.AMR) != 1 || claims.AMR[0] != token.AMREmail {
		t.Fatalf("amr = %v", claims.AMR)
	}
}

func (f *fixture) row(t *testing.T, raw string) db.Session {
	t.Helper()
	s, err := f.q.GetSessionByTokenHash(f.ctx, session.Hash(raw))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (f *fixture) events(t *testing.T, kind audit.Kind) []db.AuditEvent {
	t.Helper()
	evs, err := f.q.ListAuditEventsForUser(f.ctx, db.ListAuditEventsForUserParams{UserID: f.user.ID, PageSize: 100})
	if err != nil {
		t.Fatal(err)
	}
	var out []db.AuditEvent
	for _, e := range evs {
		if e.Event == string(kind) {
			out = append(out, e)
		}
	}
	return out
}

func reason(s db.Session) string {
	if s.RevokedReason == nil {
		return ""
	}
	return *s.RevokedReason
}

func TestSessionLifecycle(t *testing.T) {
	f := setup(t)
	var seen []string // every raw token handed out; none may appear in logs or audit metadata

	t.Run("create", func(t *testing.T) {
		before := time.Now()
		tok := f.create(t, true)
		seen = append(seen, tok.RefreshToken, tok.AccessToken)
		f.checkAccess(t, tok)
		if len(tok.RefreshToken) != 43 {
			t.Fatalf("refresh token length = %d, want 43 (32 bytes base64url)", len(tok.RefreshToken))
		}
		s := f.row(t, tok.RefreshToken)
		if s.TokenHash == tok.RefreshToken || s.ID != tok.Session.ID || s.FamilyID != s.ID || !s.Remember ||
			s.Ip == nil || s.Ip.String() != "203.0.113.7" || s.UserAgent != "itest/1.0" || s.DeviceLabel != "Firefox on macOS" {
			t.Fatalf("row = %+v", s)
		}
		if d := s.ExpiresAt.Sub(before); d < refreshTTL-time.Minute || d > refreshTTL+time.Minute {
			t.Fatalf("remember expiry in %v, want ~%v", d, refreshTTL)
		}

		short := f.create(t, false)
		seen = append(seen, short.RefreshToken, short.AccessToken)
		if d := short.Session.ExpiresAt.Sub(before); d < refreshTTLShort-time.Minute || d > refreshTTLShort+time.Minute {
			t.Fatalf("short expiry in %v, want ~%v", d, refreshTTLShort)
		}
	})

	t.Run("rotate", func(t *testing.T) {
		first := f.create(t, true)
		second, err := f.svc.Refresh(f.ctx, first.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		seen = append(seen, first.RefreshToken, second.RefreshToken, second.AccessToken)
		f.checkAccess(t, second)
		if second.RefreshToken == first.RefreshToken || second.Session.ID == first.Session.ID ||
			second.Session.FamilyID != first.Session.FamilyID || second.User.ID != f.user.ID || !second.Session.Remember {
			t.Fatalf("rotated = %+v", second.Session)
		}
		if p := f.row(t, first.RefreshToken); reason(p) != session.ReasonRotated {
			t.Fatalf("parent reason = %q, want rotated", reason(p))
		}
		third, err := f.svc.Refresh(f.ctx, second.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		seen = append(seen, third.RefreshToken)
		f.checkAccess(t, third)
	})

	t.Run("reuse revokes the family", func(t *testing.T) {
		first := f.create(t, false)
		second, err := f.svc.Refresh(f.ctx, first.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		seen = append(seen, first.RefreshToken, second.RefreshToken)
		before := len(f.events(t, audit.SessionReuseDetected))

		if _, err := f.svc.Refresh(f.ctx, first.RefreshToken); !errors.Is(err, session.ErrReuseDetected) || !errors.Is(err, session.ErrInvalidToken) {
			t.Fatalf("replay: err = %v, want ErrReuseDetected", err)
		}
		if c := f.row(t, second.RefreshToken); reason(c) != session.ReasonReuse {
			t.Fatalf("live child reason = %q, want %s", reason(c), session.ReasonReuse)
		}
		if _, err := f.svc.Refresh(f.ctx, second.RefreshToken); !errors.Is(err, session.ErrExpired) {
			t.Fatalf("child after reuse: err = %v, want ErrExpired", err)
		}
		evs := f.events(t, audit.SessionReuseDetected)
		if len(evs) != before+1 {
			t.Fatalf("reuse events = %d, want %d", len(evs), before+1)
		}
		found := false
		for _, e := range evs {
			if strings.Contains(string(e.Metadata), first.Session.FamilyID.String()) {
				found = true
				if e.Ip == nil || e.UserAgent != "itest/1.0" {
					t.Fatalf("reuse event = %+v", e)
				}
			}
		}
		if !found {
			t.Fatal("no session.reuse_detected event for the family")
		}
	})

	t.Run("concurrent refresh of one token is reuse", func(t *testing.T) {
		tok := f.create(t, true)
		seen = append(seen, tok.RefreshToken)
		var wg sync.WaitGroup
		errs := make([]error, 2)
		got := make([]session.Tokens, 2)
		for i := range errs {
			wg.Go(func() { got[i], errs[i] = f.svc.Refresh(f.ctx, tok.RefreshToken) })
		}
		wg.Wait()
		for _, g := range got {
			if g.RefreshToken != "" {
				seen = append(seen, g.RefreshToken)
			}
		}
		ok, reused := 0, 0
		for _, err := range errs {
			switch {
			case err == nil:
				ok++
			case errors.Is(err, session.ErrReuseDetected):
				reused++
			default:
				t.Fatalf("unexpected err %v", err)
			}
		}
		if ok > 1 || ok+reused != 2 || reused == 0 {
			t.Fatalf("ok=%d reused=%d, want at most one success and the rest reuse", ok, reused)
		}
		live, err := f.q.ListActiveSessionsForUser(f.ctx, f.user.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range live {
			if s.FamilyID == tok.Session.FamilyID {
				t.Fatalf("family still has a live row after reuse: %+v", s)
			}
		}
	})

	t.Run("expired", func(t *testing.T) {
		tok := f.create(t, true)
		seen = append(seen, tok.RefreshToken)
		if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, tok.Session.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Refresh(f.ctx, tok.RefreshToken); !errors.Is(err, session.ErrExpired) {
			t.Fatalf("err = %v, want ErrExpired", err)
		}
		if s := f.row(t, tok.RefreshToken); s.RevokedAt != nil {
			t.Fatalf("expired row was revoked: %+v", s)
		}
	})

	t.Run("unknown and malformed", func(t *testing.T) {
		for _, raw := range []string{"", "not base64!", strings.Repeat("A", 600), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
			if _, err := f.svc.Refresh(f.ctx, raw); !errors.Is(err, session.ErrInvalidToken) || errors.Is(err, session.ErrReuseDetected) {
				t.Fatalf("Refresh(%.10q): err = %v, want ErrInvalidToken", raw, err)
			}
		}
	})

	t.Run("logout", func(t *testing.T) {
		tok := f.create(t, true)
		seen = append(seen, tok.RefreshToken)
		before := len(f.events(t, audit.SessionRevoked))
		if err := f.svc.Logout(f.ctx, tok.RefreshToken); err != nil {
			t.Fatal(err)
		}
		if s := f.row(t, tok.RefreshToken); reason(s) != session.ReasonLogout {
			t.Fatalf("reason = %q, want logout", reason(s))
		}
		if _, err := f.svc.Refresh(f.ctx, tok.RefreshToken); !errors.Is(err, session.ErrExpired) {
			t.Fatalf("refresh after logout: err = %v, want ErrExpired", err)
		}
		if n := len(f.events(t, audit.SessionRevoked)); n != before+1 {
			t.Fatalf("session.revoked events = %d, want %d", n, before+1)
		}
		// Idempotent, and silent for unknown tokens.
		if err := f.svc.Logout(f.ctx, tok.RefreshToken); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.Logout(f.ctx, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); err != nil {
			t.Fatal(err)
		}
		if n := len(f.events(t, audit.SessionRevoked)); n != before+1 {
			t.Fatalf("session.revoked events after repeat = %d, want %d", n, before+1)
		}
	})

	t.Run("deleted user", func(t *testing.T) {
		u, err := f.q.CreateUser(f.ctx, db.CreateUserParams{ID: uuid.New(), Email: "gone@example.com"})
		if err != nil {
			t.Fatal(err)
		}
		tok, err := f.svc.Create(f.ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
		if err != nil {
			t.Fatal(err)
		}
		seen = append(seen, tok.RefreshToken)
		if _, err := f.q.SoftDeleteUser(f.ctx, db.SoftDeleteUserParams{ID: u.ID, DeleteAfter: time.Now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Refresh(f.ctx, tok.RefreshToken); !errors.Is(err, session.ErrExpired) {
			t.Fatalf("err = %v, want ErrExpired", err)
		}
		if s := f.row(t, tok.RefreshToken); reason(s) != session.ReasonUserDeleted {
			t.Fatalf("reason = %q", reason(s))
		}
	})

	t.Run("no tokens in logs or audit metadata", func(t *testing.T) {
		logs := f.logs.String()
		if !strings.Contains(logs, "reuse detected") {
			t.Fatalf("expected the reuse warning in logs, got %q", logs)
		}
		evs, err := f.q.ListAuditEventsForUser(f.ctx, db.ListAuditEventsForUserParams{UserID: f.user.ID, PageSize: 100})
		if err != nil {
			t.Fatal(err)
		}
		for _, raw := range seen {
			if strings.Contains(logs, raw) || strings.Contains(logs, session.Hash(raw)) {
				t.Fatal("a token or token hash was logged")
			}
			for _, e := range evs {
				if strings.Contains(string(e.Metadata), raw) || strings.Contains(string(e.Metadata), session.Hash(raw)) {
					t.Fatalf("token in audit metadata of %s", e.Event)
				}
			}
		}
	})
}
