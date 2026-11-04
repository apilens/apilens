//go:build integration

package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/pquerna/otp/totp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/identity/twofactor"
	"github.com/apilens/apilens/internal/testutil"
)

// recordingJobs is a twofactor.Enqueuer that keeps what it was given.
type recordingJobs struct {
	mu   sync.Mutex
	args []river.JobArgs
}

func (r *recordingJobs) InsertTx(_ context.Context, _ pgx.Tx, args river.JobArgs, _ *river.InsertOpts) (*rivertype.JobInsertResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.args = append(r.args, args)
	return &rivertype.JobInsertResult{}, nil
}

func (r *recordingJobs) emails() []email.SendArgs {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []email.SendArgs
	for _, a := range r.args {
		if e, ok := a.(email.SendArgs); ok {
			out = append(out, e)
		}
	}
	return out
}

type twoFactorFixture struct {
	*meFixture
	svc  *twofactor.Service
	jobs *recordingJobs
}

func setupTwoFactor(t *testing.T) *twoFactorFixture {
	t.Helper()
	f := setupMe(t)
	jobs := &recordingJobs{}
	svc, err := twofactor.New(f.pool, bytes.Repeat([]byte{9}, 32), jobs)
	if err != nil {
		t.Fatal(err)
	}
	NewTwoFactor(svc, testutil.Logger(t)).Register(f.api)
	return &twoFactorFixture{meFixture: f, svc: svc, jobs: jobs}
}

func problemCode(t *testing.T, body []byte) ErrCode {
	t.Helper()
	var p struct {
		Code ErrCode `json:"code"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return p.Code
}

func (f *twoFactorFixture) enable(t *testing.T, auth string) (secret, uri string) {
	t.Helper()
	resp := f.api.Post(TwoFactorPrefix+"/enable", auth)
	if resp.Code != http.StatusOK {
		t.Fatalf("enable: status = %d: %s", resp.Code, resp.Body)
	}
	var out struct {
		Secret     string `json:"secret"`
		OTPAuthURI string `json:"otpauth_uri"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Secret, out.OTPAuthURI
}

func code(t *testing.T, secret string) string {
	t.Helper()
	c, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestTwoFactorEnableAndVerify(t *testing.T) {
	f := setupTwoFactor(t)
	u, auth := f.signIn(t, "totp@example.com")

	if resp := f.api.Post(TwoFactorPrefix + "/enable"); resp.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status = %d", resp.Code)
	}
	// Verify before enable: nothing pending.
	resp := f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": "123456"})
	if resp.Code != http.StatusBadRequest || problemCode(t, resp.Body.Bytes()) != CodeInvalidRequest {
		t.Fatalf("verify before enable: %d %s", resp.Code, resp.Body)
	}

	secret, uri := f.enable(t, auth)
	parsed, err := url.Parse(uri)
	if err != nil || parsed.Scheme != "otpauth" || parsed.Host != "totp" {
		t.Fatalf("otpauth uri %q: %v", uri, err)
	}
	if q := parsed.Query(); q.Get("issuer") != "APILens" || q.Get("secret") != secret {
		t.Fatalf("otpauth uri query: %v", q)
	}
	if !strings.Contains(parsed.Path, "totp@example.com") {
		t.Fatalf("otpauth uri must name the account: %q", parsed.Path)
	}

	// Enabling again before confirming replaces the pending secret.
	first := secret
	secret, _ = f.enable(t, auth)
	if secret == first {
		t.Fatal("re-enable before confirmation must issue a new secret")
	}

	// The secret is stored as ciphertext bound to the user.
	row, err := f.q.GetTOTPForUser(f.ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.ConfirmedAt != nil {
		t.Fatal("secret must be unconfirmed before verify")
	}
	if bytes.Contains(row.SecretEnc, []byte(secret)) || bytes.Contains(bytes.ToLower(row.SecretEnc), []byte(strings.ToLower(secret))) {
		t.Fatal("secret_enc contains the plaintext secret")
	}
	if opened, err := f.svc.OpenSecret(u.ID, row.SecretEnc); err != nil || opened != secret {
		t.Fatalf("open stored secret = %q, %v", opened, err)
	}

	// A wrong code.
	wrong := "000000"
	if code(t, secret) == wrong {
		wrong = "000001"
	}
	resp = f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": wrong})
	if resp.Code != http.StatusUnauthorized || problemCode(t, resp.Body.Bytes()) != CodeInvalidTOTP {
		t.Fatalf("wrong code: %d %s", resp.Code, resp.Body)
	}
	// The old pending secret no longer works.
	if c1, c2 := code(t, first), code(t, secret); c1 != c2 {
		resp = f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": c1})
		if resp.Code != http.StatusUnauthorized {
			t.Fatalf("replaced secret's code: %d %s", resp.Code, resp.Body)
		}
	}
	if len(f.events(t, u.ID, audit.TOTPEnabled)) != 0 || len(f.jobs.emails()) != 0 {
		t.Fatal("no audit or email before confirmation")
	}

	// Confirm.
	resp = f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": code(t, secret)})
	if resp.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", resp.Code, resp.Body)
	}
	var out struct {
		BackupCodes []string `json:"backup_codes"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.BackupCodes) != 10 {
		t.Fatalf("got %d backup codes, want 10", len(out.BackupCodes))
	}
	format := regexp.MustCompile(`^[a-z2-7]{4}-[a-z2-7]{4}$`)
	for _, c := range out.BackupCodes {
		if !format.MatchString(c) {
			t.Fatalf("backup code %q is not xxxx-xxxx", c)
		}
	}
	row, err = f.q.GetTOTPForUser(f.ctx, u.ID)
	if err != nil || row.ConfirmedAt == nil {
		t.Fatalf("secret must be confirmed: %+v %v", row, err)
	}
	if n, err := f.q.CountUnusedBackupCodesForUser(f.ctx, u.ID); err != nil || n != 10 {
		t.Fatalf("stored backup codes = %d, %v", n, err)
	}
	// Codes are stored hashed: the raw code is not a stored hash, its hash is.
	if _, err := f.q.UseBackupCode(f.ctx, db.UseBackupCodeParams{UserID: u.ID, CodeHash: out.BackupCodes[0]}); err == nil {
		t.Fatal("a raw code must not be stored")
	}
	if _, err := f.q.UseBackupCode(f.ctx, db.UseBackupCodeParams{UserID: u.ID, CodeHash: twofactor.HashBackupCode(u.ID, out.BackupCodes[0])}); err != nil {
		t.Fatalf("the code's hash must be stored: %v", err)
	}

	evs := f.events(t, u.ID, audit.TOTPEnabled)
	if len(evs) != 1 {
		t.Fatalf("totp.enabled events = %d, want 1", len(evs))
	}
	if strings.Contains(string(evs[0].Metadata), out.BackupCodes[1]) || strings.Contains(string(evs[0].Metadata), secret) {
		t.Fatal("audit metadata must not hold secrets")
	}
	mails := f.jobs.emails()
	if len(mails) != 1 {
		t.Fatalf("emails = %d, want 1", len(mails))
	}
	if m := mails[0]; m.To != "totp@example.com" || m.Template != email.TemplateSecurityChange || m.Data["change"] != email.SecurityChangeTOTPEnabled {
		t.Fatalf("email = %+v", m)
	}
	// humatest requests carry no audit.Middleware client, so ip is empty here.
	if _, ok := mails[0].Data["ip"].(string); !ok || mails[0].Data["device"] == "" || mails[0].Data["time"] == "" {
		t.Fatalf("email data = %v", mails[0].Data)
	}

	// Already enabled: enable and verify both refuse, and nothing changes.
	resp = f.api.Post(TwoFactorPrefix+"/enable", auth)
	if resp.Code != http.StatusConflict || problemCode(t, resp.Body.Bytes()) != CodeAlreadyEnabled {
		t.Fatalf("re-enable: %d %s", resp.Code, resp.Body)
	}
	resp = f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": code(t, secret)})
	if resp.Code != http.StatusConflict || problemCode(t, resp.Body.Bytes()) != CodeAlreadyEnabled {
		t.Fatalf("re-verify: %d %s", resp.Code, resp.Body)
	}
	after, err := f.q.GetTOTPForUser(f.ctx, u.ID)
	if err != nil || !bytes.Equal(after.SecretEnc, row.SecretEnc) {
		t.Fatalf("confirmed secret must be kept: %v", err)
	}
	if len(f.jobs.emails()) != 1 {
		t.Fatal("no second email")
	}
}

func TestTwoFactorEnableNeedsRecentSignIn(t *testing.T) {
	f := setupTwoFactor(t)
	u, auth := f.signIn(t, "stale@example.com")
	if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE user_id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	resp := f.api.Post(TwoFactorPrefix+"/enable", auth)
	if resp.Code != http.StatusForbidden || problemCode(t, resp.Body.Bytes()) != CodeReauthRequired {
		t.Fatalf("stale sign-in: %d %s", resp.Code, resp.Body)
	}
	if _, err := f.q.GetTOTPForUser(f.ctx, u.ID); err == nil {
		t.Fatal("no secret must be stored")
	}

	// A fresh sign-in may.
	tok, err := f.sessions.Create(f.ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		t.Fatal(err)
	}
	fresh := "Authorization: Bearer " + tok.AccessToken
	if resp := f.api.Post(TwoFactorPrefix+"/enable", fresh); resp.Code != http.StatusOK {
		t.Fatalf("fresh sign-in: %d %s", resp.Code, resp.Body)
	}
}

func TestTwoFactorVerifyValidatesCode(t *testing.T) {
	f := setupTwoFactor(t)
	_, auth := f.signIn(t, "shape@example.com")
	f.enable(t, auth)
	for _, c := range []string{"", "12345", "1234567", "abcdef"} {
		if resp := f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": c}); resp.Code != http.StatusUnprocessableEntity {
			t.Errorf("code %q: status = %d", c, resp.Code)
		}
	}
}
