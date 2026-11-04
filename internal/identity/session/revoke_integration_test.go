//go:build integration

package session_test

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
)

// recordingDenier records the sids pushed into the denylist.
type recordingDenier struct {
	mu   sync.Mutex
	sids []uuid.UUID
	err  error
}

func (d *recordingDenier) Deny(_ context.Context, sids ...uuid.UUID) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sids = append(d.sids, sids...)
	return d.err
}

// take returns and clears the recorded sids.
func (d *recordingDenier) take() []uuid.UUID {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := d.sids
	d.sids = nil
	return out
}

func sameIDs(got []uuid.UUID, want ...uuid.UUID) bool {
	a, b := slices.Clone(got), slices.Clone(want)
	cmp := func(x, y uuid.UUID) int { return strings.Compare(x.String(), y.String()) }
	slices.SortFunc(a, cmp)
	slices.SortFunc(b, cmp)
	return slices.Equal(a, b)
}

func TestRevocation(t *testing.T) {
	f := setup(t)
	deny := &recordingDenier{}
	svc, err := session.New(f.pool, f.issuer, session.Options{
		RefreshTTL: refreshTTL, RefreshTTLShort: refreshTTLShort,
		AccessTTL: 15 * time.Minute, Denylist: deny,
	}, slog.New(slog.NewJSONHandler(f.logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	signIn := func(t *testing.T, u db.User) session.Tokens {
		t.Helper()
		tok, err := svc.Create(f.ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	newUser := func(t *testing.T) db.User {
		t.Helper()
		u, err := f.q.CreateUser(f.ctx, db.CreateUserParams{ID: uuid.New(), Email: uuid.NewString() + "@example.com"})
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	revokedEvents := func(t *testing.T, user uuid.UUID) []db.AuditEvent {
		t.Helper()
		evs, err := f.q.ListAuditEventsForUser(f.ctx, db.ListAuditEventsForUserParams{UserID: user, PageSize: 100})
		if err != nil {
			t.Fatal(err)
		}
		var out []db.AuditEvent
		for _, e := range evs {
			if e.Event == string(audit.SessionRevoked) {
				out = append(out, e)
			}
		}
		return out
	}
	live := func(t *testing.T, user uuid.UUID) []db.Session {
		t.Helper()
		rows, err := f.q.ListActiveSessionsForUser(f.ctx, user)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}

	t.Run("revoke one session denylists its family's token sessions", func(t *testing.T) {
		u := newUser(t)
		laptop := signIn(t, u)
		rotated, err := svc.Refresh(f.ctx, laptop.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		phone := signIn(t, u)
		deny.take()

		// Any row of the family names it: here the stale pre-refresh id.
		if err := svc.Revoke(f.ctx, u.ID, laptop.Session.ID); err != nil {
			t.Fatal(err)
		}
		// Both the rotated parent (its access token is still unexpired) and
		// the live child are denylisted; the phone is not.
		if got := deny.take(); !sameIDs(got, laptop.Session.ID, rotated.Session.ID) {
			t.Fatalf("denied %v, want the laptop family's rows", got)
		}
		if rows := live(t, u.ID); len(rows) != 1 || rows[0].ID != phone.Session.ID {
			t.Fatalf("live = %+v, want only the phone", rows)
		}
		if _, err := svc.Refresh(f.ctx, rotated.RefreshToken); !errors.Is(err, session.ErrExpired) {
			t.Fatalf("refresh revoked session: err = %v, want ErrExpired", err)
		}
		evs := revokedEvents(t, u.ID)
		if len(evs) != 1 || !strings.Contains(string(evs[0].Metadata), `"reason": "revoked"`) ||
			evs[0].ActorUserID == nil || *evs[0].ActorUserID != u.ID {
			t.Fatalf("events = %+v", evs)
		}

		// Idempotent: again, an unknown id and another user's session are
		// no-ops, neither audited nor denylisted.
		other := newUser(t)
		theirs := signIn(t, other)
		deny.take()
		for _, id := range []uuid.UUID{laptop.Session.ID, uuid.New(), theirs.Session.ID} {
			if err := svc.Revoke(f.ctx, u.ID, id); err != nil {
				t.Fatal(err)
			}
		}
		if got := deny.take(); len(got) != 0 {
			t.Fatalf("denied %v on no-ops", got)
		}
		if n := len(revokedEvents(t, u.ID)); n != 1 {
			t.Fatalf("events = %d after no-ops", n)
		}
		if rows := live(t, other.ID); len(rows) != 1 {
			t.Fatal("another user's session was revoked")
		}
	})

	t.Run("revoke others keeps the current family", func(t *testing.T) {
		u := newUser(t)
		current := signIn(t, u)
		next, err := svc.Refresh(f.ctx, current.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		a, b := signIn(t, u), signIn(t, u)
		deny.take()

		// The caller's token may name the rotated parent; the family is kept.
		n, err := svc.RevokeOthers(f.ctx, u.ID, current.Session.ID)
		if err != nil || n != 2 {
			t.Fatalf("revoked %d, err %v; want 2", n, err)
		}
		if got := deny.take(); !sameIDs(got, a.Session.ID, b.Session.ID) {
			t.Fatalf("denied %v, want the other two sessions", got)
		}
		if rows := live(t, u.ID); len(rows) != 1 || rows[0].ID != next.Session.ID {
			t.Fatalf("live = %+v", rows)
		}
		evs := revokedEvents(t, u.ID)
		if len(evs) != 1 || !strings.Contains(string(evs[0].Metadata), `"revoked": 2`) {
			t.Fatalf("events = %+v", evs)
		}

		// Nothing left to revoke: no event, no denials.
		if n, err := svc.RevokeOthers(f.ctx, u.ID, next.Session.ID); err != nil || n != 0 {
			t.Fatalf("second call: %d, %v", n, err)
		}
		if got := deny.take(); len(got) != 0 || len(revokedEvents(t, u.ID)) != 1 {
			t.Fatalf("no-op denied %v", got)
		}
		if _, err := svc.RevokeOthers(f.ctx, u.ID, uuid.New()); !errors.Is(err, session.ErrExpired) {
			t.Fatalf("unknown current session: err = %v, want ErrExpired", err)
		}
	})

	t.Run("logout all", func(t *testing.T) {
		u := newUser(t)
		a, b := signIn(t, u), signIn(t, u)
		other := newUser(t)
		signIn(t, other)
		deny.take()

		n, err := svc.LogoutAll(f.ctx, u.ID)
		if err != nil || n != 2 {
			t.Fatalf("revoked %d, err %v; want 2", n, err)
		}
		if got := deny.take(); !sameIDs(got, a.Session.ID, b.Session.ID) {
			t.Fatalf("denied %v", got)
		}
		if rows := live(t, u.ID); len(rows) != 0 {
			t.Fatalf("live = %+v", rows)
		}
		if rows := live(t, other.ID); len(rows) != 1 {
			t.Fatal("another user's session was revoked")
		}
		evs := revokedEvents(t, u.ID)
		if len(evs) != 1 || !strings.Contains(string(evs[0].Metadata), `"reason": "logout_all"`) {
			t.Fatalf("events = %+v", evs)
		}
	})

	t.Run("logout and reuse denylist too", func(t *testing.T) {
		u := newUser(t)
		tok := signIn(t, u)
		deny.take()
		if err := svc.Logout(f.ctx, tok.RefreshToken); err != nil {
			t.Fatal(err)
		}
		if got := deny.take(); !sameIDs(got, tok.Session.ID) {
			t.Fatalf("logout denied %v", got)
		}

		first := signIn(t, u)
		second, err := svc.Refresh(f.ctx, first.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		deny.take()
		if _, err := svc.Refresh(f.ctx, first.RefreshToken); !errors.Is(err, session.ErrReuseDetected) {
			t.Fatal(err)
		}
		if got := deny.take(); !sameIDs(got, first.Session.ID, second.Session.ID) {
			t.Fatalf("reuse denied %v", got)
		}
	})

	t.Run("old rows are not denylisted", func(t *testing.T) {
		u := newUser(t)
		first := signIn(t, u)
		second, err := svc.Refresh(f.ctx, first.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		// The parent was rotated long ago: its access token has expired.
		if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET revoked_at = now() - interval '1 hour' WHERE id = $1`, first.Session.ID); err != nil {
			t.Fatal(err)
		}
		deny.take()
		if _, err := svc.LogoutAll(f.ctx, u.ID); err != nil {
			t.Fatal(err)
		}
		if got := deny.take(); !sameIDs(got, second.Session.ID) {
			t.Fatalf("denied %v, want only the live row", got)
		}
	})

	t.Run("denylist failure does not fail revocation", func(t *testing.T) {
		u := newUser(t)
		signIn(t, u)
		deny.err = errors.New("valkey down")
		defer func() { deny.err = nil }()
		if n, err := svc.LogoutAll(f.ctx, u.ID); err != nil || n != 1 {
			t.Fatalf("revoked %d, err %v", n, err)
		}
		if !strings.Contains(f.logs.String(), "valkey down") {
			t.Fatal("denylist failure not logged")
		}
	})
}
