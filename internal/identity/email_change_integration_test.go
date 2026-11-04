//go:build integration

package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/emailchange"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

// setupEmailChange serves the account and email change endpoints over real
// Postgres (users, sessions, auth_email_tokens, audit_events, River jobs).
func setupEmailChange(t *testing.T) *meFixture {
	t.Helper()
	f := setupMe(t)
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(f.pool, config.JobsConfig{}, reg, time.Second, testutil.Logger(t), prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	codes := emailauth.New(emailauth.NewStore(f.pool), emailauth.Options{})
	NewEmailChange(emailchange.New(f.pool, codes, jc), testutil.Logger(t)).Register(f.api)
	return f
}

// emailJobs returns the enqueued email.send jobs, oldest first.
func (f *meFixture) emailJobs(t *testing.T) []email.SendArgs {
	t.Helper()
	rows, err := f.pool.Query(f.ctx, `SELECT args FROM river_job WHERE kind = 'email.send' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []email.SendArgs
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var a email.SendArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			t.Fatal(err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// lastCode returns the code of the newest email_change email sent to to.
func (f *meFixture) lastCode(t *testing.T, to string) string {
	t.Helper()
	jobs := f.emailJobs(t)
	for i := len(jobs) - 1; i >= 0; i-- {
		if j := jobs[i]; j.To == to && j.Template == email.TemplateEmailChange {
			code, _ := j.Data["code"].(string)
			return code
		}
	}
	t.Fatalf("no email_change email to %s in %+v", to, jobs)
	return ""
}

func emailChangeProblemCode(t *testing.T, resp *httptest.ResponseRecorder) ErrCode {
	t.Helper()
	var p Problem
	if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode problem %s: %v", resp.Body, err)
	}
	return p.Code
}

// wrongCode returns a well-formed code different from code.
func wrongCode(code string) string {
	if code == "000000" {
		return "111111"
	}
	return "000000"
}

func TestEmailChange(t *testing.T) {
	f := setupEmailChange(t)
	u, auth := f.signIn(t, "old@example.com")
	other, err := f.sessions.Create(f.ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		t.Fatal(err)
	}

	resp := f.api.Post(EmailChangePath, auth, map[string]any{"new_email": "New@Example.com"})
	if resp.Code != http.StatusAccepted {
		t.Fatalf("change: status = %d: %s", resp.Code, resp.Body)
	}
	var started struct {
		PendingEmail string    `json:"pending_email"`
		ExpiresAt    time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.PendingEmail != "New@Example.com" || time.Until(started.ExpiresAt) < emailauth.TTL-time.Minute {
		t.Fatalf("change response = %+v", started)
	}
	code := f.lastCode(t, "New@Example.com")

	// Nothing changes until the code is confirmed.
	if m := decodeMe(t, f.api.Get(MePath, auth).Body.Bytes()); m.Email != "old@example.com" {
		t.Fatalf("email before confirm = %s", m.Email)
	}

	resp = f.api.Post(EmailConfirmPath, auth, map[string]any{"code": wrongCode(code)})
	if resp.Code != http.StatusBadRequest || emailChangeProblemCode(t, resp) != CodeInvalidCode {
		t.Fatalf("wrong code: status = %d: %s", resp.Code, resp.Body)
	}

	resp = f.api.Post(EmailConfirmPath, auth, map[string]any{"code": code[:3] + " " + code[3:]})
	if resp.Code != http.StatusOK {
		t.Fatalf("confirm: status = %d: %s", resp.Code, resp.Body)
	}
	m := decodeMe(t, resp.Body.Bytes())
	if m.Email != "New@Example.com" || !m.EmailVerified || m.ID != u.ID.String() {
		t.Fatalf("confirmed me = %+v", m)
	}
	if m := decodeMe(t, f.api.Get(MePath, auth).Body.Bytes()); m.Email != "New@Example.com" {
		t.Fatalf("email after confirm = %s", m.Email)
	}

	// The code works once.
	resp = f.api.Post(EmailConfirmPath, auth, map[string]any{"code": code})
	if resp.Code != http.StatusBadRequest || emailChangeProblemCode(t, resp) != CodeInvalidCode {
		t.Fatalf("reused code: status = %d: %s", resp.Code, resp.Body)
	}

	// Every other session is signed out; the current one is kept.
	if _, err := f.sessions.Refresh(f.ctx, other.RefreshToken); err == nil {
		t.Fatal("other session still refreshes")
	}
	live, err := f.q.ListActiveSessionsForUser(f.ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0].ID == other.Session.ID {
		t.Fatalf("live sessions = %+v, want only the current one", live)
	}
	var reason *string
	if err := f.pool.QueryRow(f.ctx, `SELECT revoked_reason FROM sessions WHERE id = $1`, other.Session.ID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason == nil || *reason != session.ReasonEmailChanged {
		t.Fatalf("other session revoked_reason = %v", reason)
	}

	// The old address is alerted.
	var alerts []email.SendArgs
	for _, j := range f.emailJobs(t) {
		if j.Template == email.TemplateSecurityChange {
			alerts = append(alerts, j)
		}
	}
	if len(alerts) != 1 || alerts[0].To != "old@example.com" || alerts[0].Data["change"] != email.SecurityChangeEmailChanged {
		t.Fatalf("security alerts = %+v", alerts)
	}

	evs := f.events(t, u.ID, audit.EmailChanged)
	if len(evs) != 1 {
		t.Fatalf("email.changed events = %d, want 1", len(evs))
	}
	var meta struct {
		SessionsRevoked int `json:"sessions_revoked"`
	}
	if err := json.Unmarshal(evs[0].Metadata, &meta); err != nil || meta.SessionsRevoked != 1 {
		t.Fatalf("audit meta = %s (%v)", evs[0].Metadata, err)
	}
	if evs[0].ActorUserID == nil || *evs[0].ActorUserID != u.ID {
		t.Fatalf("audit actor = %v", evs[0].ActorUserID)
	}
}

func TestEmailChangeRefusals(t *testing.T) {
	f := setupEmailChange(t)
	u, auth := f.signIn(t, "ada@example.com")
	if _, err := f.q.CreateUser(f.ctx, db.CreateUserParams{ID: uuid.New(), Email: "taken@example.com"}); err != nil {
		t.Fatal(err)
	}

	for name, tc := range map[string]struct {
		email  string
		status int
		code   ErrCode
	}{
		"taken (any case)": {"Taken@Example.com", http.StatusConflict, CodeEmailTaken},
		"same address":     {"ADA@example.com", http.StatusBadRequest, CodeInvalidRequest},
	} {
		resp := f.api.Post(EmailChangePath, auth, map[string]any{"new_email": tc.email})
		if resp.Code != tc.status || emailChangeProblemCode(t, resp) != tc.code {
			t.Errorf("%s: status = %d: %s", name, resp.Code, resp.Body)
		}
	}
	if resp := f.api.Post(EmailChangePath, auth, map[string]any{"new_email": "not an email"}); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("malformed email: status = %d", resp.Code)
	}
	if resp := f.api.Post(EmailChangePath, map[string]any{"new_email": "x@example.com"}); resp.Code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d", resp.Code)
	}
	if n := len(f.emailJobs(t)); n != 0 {
		t.Fatalf("refused changes sent %d emails", n)
	}

	// No pending change.
	resp := f.api.Post(EmailConfirmPath, auth, map[string]any{"code": "123456"})
	if resp.Code != http.StatusBadRequest || emailChangeProblemCode(t, resp) != CodeInvalidCode {
		t.Fatalf("no pending change: status = %d: %s", resp.Code, resp.Body)
	}

	// A new request replaces the pending one.
	if resp := f.api.Post(EmailChangePath, auth, map[string]any{"new_email": "first@example.com"}); resp.Code != http.StatusAccepted {
		t.Fatalf("first change: status = %d: %s", resp.Code, resp.Body)
	}
	first := f.lastCode(t, "first@example.com")
	if resp := f.api.Post(EmailChangePath, auth, map[string]any{"new_email": "second@example.com"}); resp.Code != http.StatusAccepted {
		t.Fatalf("second change: status = %d: %s", resp.Code, resp.Body)
	}
	second := f.lastCode(t, "second@example.com")
	if first != second {
		resp = f.api.Post(EmailConfirmPath, auth, map[string]any{"code": first})
		if resp.Code != http.StatusBadRequest || emailChangeProblemCode(t, resp) != CodeInvalidCode {
			t.Fatalf("superseded code: status = %d: %s", resp.Code, resp.Body)
		}
	}

	// The address is taken between the request and the confirmation.
	if _, err := f.q.CreateUser(f.ctx, db.CreateUserParams{ID: uuid.New(), Email: "second@example.com"}); err != nil {
		t.Fatal(err)
	}
	resp = f.api.Post(EmailConfirmPath, auth, map[string]any{"code": second})
	if resp.Code != http.StatusConflict || emailChangeProblemCode(t, resp) != CodeEmailTaken {
		t.Fatalf("taken since: status = %d: %s", resp.Code, resp.Body)
	}
	stored, err := f.q.GetUserByID(f.ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Email != "ada@example.com" {
		t.Fatalf("email = %s after refused changes", stored.Email)
	}
	if n := len(f.events(t, u.ID, audit.EmailChanged)); n != 0 {
		t.Fatalf("email.changed events = %d, want 0", n)
	}
}

func TestEmailChangeTooManyAttempts(t *testing.T) {
	f := setupEmailChange(t)
	_, auth := f.signIn(t, "guess@example.com")
	if resp := f.api.Post(EmailChangePath, auth, map[string]any{"new_email": "guess-new@example.com"}); resp.Code != http.StatusAccepted {
		t.Fatalf("change: status = %d: %s", resp.Code, resp.Body)
	}
	code := f.lastCode(t, "guess-new@example.com")
	var last *httptest.ResponseRecorder
	for range emailauth.MaxAttempts {
		last = f.api.Post(EmailConfirmPath, auth, map[string]any{"code": wrongCode(code)})
	}
	if last.Code != http.StatusTooManyRequests || emailChangeProblemCode(t, last) != CodeTooManyAttempts {
		t.Fatalf("after %d wrong codes: status = %d: %s", emailauth.MaxAttempts, last.Code, last.Body)
	}
	// The burned code no longer works, even when right.
	resp := f.api.Post(EmailConfirmPath, auth, map[string]any{"code": code})
	if resp.Code != http.StatusTooManyRequests || emailChangeProblemCode(t, resp) != CodeTooManyAttempts {
		t.Fatalf("right code after lockout: status = %d: %s", resp.Code, resp.Body)
	}
}
