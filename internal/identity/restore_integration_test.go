//go:build integration

package identity

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

type restoreFixture struct {
	*meFixture
	accounts *account.Service
	codes    *emailauth.Service
}

// setupRestore serves the account endpoints plus the restore endpoint, with
// real email codes. Rate limits are off (no Valkey).
func setupRestore(t *testing.T) *restoreFixture {
	t.Helper()
	f := setupMe(t)
	limiter, err := ratelimit.New(nil, testutil.Logger(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	accounts := account.New(f.pool, nil)
	codes := emailauth.New(emailauth.NewStore(f.pool), emailauth.Options{})
	NewRestore(config.IdentityConfig{}, accounts, codes, limiter, testutil.Logger(t)).Register(f.api)
	return &restoreFixture{meFixture: f, accounts: accounts, codes: codes}
}

func (f *restoreFixture) code(t *testing.T, email string) string {
	t.Helper()
	issued, err := f.codes.Issue(f.ctx, email, emailauth.IntentSignIn, emailauth.IssueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return issued.Code
}

func (f *restoreFixture) restore(email, code string) (int, problemBody, []byte) {
	resp := f.api.Post(RestorePath, map[string]any{"email": email, "code": code})
	var p problemBody
	_ = json.Unmarshal(resp.Body.Bytes(), &p)
	return resp.Code, p, resp.Body.Bytes()
}

func TestRestoreDeletedAccount(t *testing.T) {
	f := setupRestore(t)
	const email = "restore@example.com"
	u, auth := f.signIn(t, email)
	if resp := f.api.Delete(MePath, auth); resp.Code != http.StatusOK {
		t.Fatalf("delete: status = %d: %s", resp.Code, resp.Body)
	}

	// Sign-in finds the pending deletion and answers account_deleting.
	pending, err := f.accounts.PendingDeletion(f.ctx, "Restore@Example.com")
	if err != nil {
		t.Fatalf("pending deletion: %v", err)
	}
	if pending.ID != u.ID || pending.DeleteAfter == nil {
		t.Fatalf("pending = %+v", pending)
	}
	resp, body := serveProblem(t, ErrAccountDeleting(*pending.DeleteAfter))
	if resp.StatusCode != http.StatusConflict || body.Code != CodeAccountDeleting {
		t.Fatalf("account_deleting: %d %+v", resp.StatusCode, body)
	}

	// A wrong code restores nothing.
	good := f.code(t, email)
	wrong := good[:len(good)-1] + string(rune('0'+(good[len(good)-1]-'0'+1)%10))
	if status, p, raw := f.restore(email, wrong); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
		t.Fatalf("wrong code: %d %s", status, raw)
	}
	if f.isActive(t, u.ID) {
		t.Fatal("wrong code restored the account")
	}

	// A fresh code restores the account.
	code := f.code(t, email)
	status, _, raw := f.restore(email, code)
	if status != http.StatusOK {
		t.Fatalf("restore: status = %d: %s", status, raw)
	}
	var out struct {
		User AuthUser `json:"user"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.User.ID != u.ID.String() {
		t.Fatalf("restore body = %s (%v)", raw, err)
	}
	got, err := f.q.GetUserByID(f.ctx, u.ID)
	if err != nil {
		t.Fatalf("restored user not active: %v", err)
	}
	if got.DeletedAt != nil || got.DeleteAfter != nil {
		t.Fatalf("deleted_at = %v, delete_after = %v", got.DeletedAt, got.DeleteAfter)
	}
	if _, err := f.accounts.PendingDeletion(f.ctx, email); !errors.Is(err, account.ErrNotFound) {
		t.Fatalf("pending after restore: %v", err)
	}
	if n := len(f.events(t, u.ID, audit.UserRestored)); n != 1 {
		t.Fatalf("user.restored events = %d, want 1", n)
	}

	// The used code cannot restore again, and there is nothing to restore.
	if status, p, raw := f.restore(email, code); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
		t.Fatalf("replay: %d %s", status, raw)
	}
	if status, p, raw := f.restore(email, f.code(t, email)); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
		t.Fatalf("active account: %d %s", status, raw)
	}
}

func (f *restoreFixture) isActive(t *testing.T, id uuid.UUID) bool {
	t.Helper()
	var deleted bool
	if err := f.pool.QueryRow(f.ctx, `SELECT deleted_at IS NOT NULL FROM users WHERE id = $1`, id).Scan(&deleted); err != nil {
		t.Fatal(err)
	}
	return !deleted
}

func TestRestoreRefused(t *testing.T) {
	f := setupRestore(t)

	// No deleted account for the address.
	const nobody = "nobody@example.com"
	if status, p, raw := f.restore(nobody, f.code(t, nobody)); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
		t.Fatalf("unknown address: %d %s", status, raw)
	}

	// Past the grace period: not restorable, and sign-in sees no pending
	// deletion (the purge job removes it).
	const late = "late@example.com"
	u, auth := f.signIn(t, late)
	if resp := f.api.Delete(MePath, auth); resp.Code != http.StatusOK {
		t.Fatalf("delete: %d", resp.Code)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET delete_after = now() - interval '1 minute' WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.accounts.PendingDeletion(f.ctx, late); !errors.Is(err, account.ErrNotFound) {
		t.Fatalf("pending past grace: %v", err)
	}
	if status, p, raw := f.restore(late, f.code(t, late)); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
		t.Fatalf("past grace: %d %s", status, raw)
	}

	// The address signed up again: the new account wins, the old one stays
	// deleted.
	const again = "again@example.com"
	old, auth := f.signIn(t, again)
	if resp := f.api.Delete(MePath, auth); resp.Code != http.StatusOK {
		t.Fatalf("delete: %d", resp.Code)
	}
	verified := time.Now()
	if _, err := f.q.CreateUser(f.ctx, db.CreateUserParams{ID: uuid.New(), Email: again, EmailVerifiedAt: &verified}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.accounts.PendingDeletion(f.ctx, again); !errors.Is(err, account.ErrNotFound) {
		t.Fatalf("pending with active account: %v", err)
	}
	if status, p, raw := f.restore(again, f.code(t, again)); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
		t.Fatalf("re-registered: %d %s", status, raw)
	}
	if f.isActive(t, old.ID) {
		t.Fatal("old account restored over the new one")
	}
}
