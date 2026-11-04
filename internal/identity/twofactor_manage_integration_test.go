//go:build integration

package identity

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/identity/twofactor"
)

// confirm turns 2FA on for the signed-in user and returns the secret and
// backup codes.
func (f *twoFactorFixture) confirm(t *testing.T, auth string) (string, []string) {
	t.Helper()
	secret, _ := f.enable(t, auth)
	resp := f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": code(t, secret)})
	if resp.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", resp.Code, resp.Body)
	}
	return secret, backupCodes(t, resp.Body.Bytes())
}

func backupCodes(t *testing.T, body []byte) []string {
	t.Helper()
	var out struct {
		BackupCodes []string `json:"backup_codes"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out.BackupCodes
}

type twoFactorStatus struct {
	Enabled              bool       `json:"enabled"`
	ConfirmedAt          *time.Time `json:"confirmed_at"`
	BackupCodesRemaining int        `json:"backup_codes_remaining"`
}

func (f *twoFactorFixture) status(t *testing.T, auth string) twoFactorStatus {
	t.Helper()
	resp := f.api.Get(TwoFactorPrefix+"/status", auth)
	if resp.Code != http.StatusOK {
		t.Fatalf("status: %d %s", resp.Code, resp.Body)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(resp.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["confirmed_at"]; !ok {
		t.Fatalf("confirmed_at must always be present: %s", resp.Body)
	}
	var st twoFactorStatus
	if err := json.Unmarshal(resp.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	return st
}

func (f *twoFactorFixture) revokeSessions(t *testing.T, user uuid.UUID) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE user_id = $1 AND revoked_at IS NULL`, user); err != nil {
		t.Fatal(err)
	}
}

func expectProblem(t *testing.T, name string, resp *httptest.ResponseRecorder, status int, want ErrCode) {
	t.Helper()
	if resp.Code != status || problemCode(t, resp.Body.Bytes()) != want {
		t.Fatalf("%s: %d %s, want %d %s", name, resp.Code, resp.Body, status, want)
	}
}

func TestTwoFactorStatus(t *testing.T) {
	f := setupTwoFactor(t)
	u, auth := f.signIn(t, "status@example.com")

	if resp := f.api.Get(TwoFactorPrefix + "/status"); resp.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status = %d", resp.Code)
	}
	if st := f.status(t, auth); st.Enabled || st.ConfirmedAt != nil || st.BackupCodesRemaining != 0 {
		t.Fatalf("off: %+v", st)
	}
	// A pending, unconfirmed secret is still off.
	secret, _ := f.enable(t, auth)
	if st := f.status(t, auth); st.Enabled || st.ConfirmedAt != nil {
		t.Fatalf("pending: %+v", st)
	}

	resp := f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": code(t, secret)})
	if resp.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", resp.Code, resp.Body)
	}
	codes := backupCodes(t, resp.Body.Bytes())
	st := f.status(t, auth)
	if !st.Enabled || st.ConfirmedAt == nil || time.Since(*st.ConfirmedAt) > time.Minute || st.BackupCodesRemaining != 10 {
		t.Fatalf("on: %+v", st)
	}
	if _, err := f.q.UseBackupCode(f.ctx, db.UseBackupCodeParams{UserID: u.ID, CodeHash: twofactor.HashBackupCode(u.ID, codes[0])}); err != nil {
		t.Fatal(err)
	}
	if st := f.status(t, auth); st.BackupCodesRemaining != 9 {
		t.Fatalf("after one used: %+v", st)
	}

	// A revoked session's still-valid access token is refused.
	f.revokeSessions(t, u.ID)
	resp = f.api.Get(TwoFactorPrefix+"/status", auth)
	expectProblem(t, "revoked session", resp, http.StatusUnauthorized, CodeSessionExpired)
}

func TestTwoFactorDisable(t *testing.T) {
	f := setupTwoFactor(t)
	u, auth := f.signIn(t, "disable@example.com")
	path := TwoFactorPrefix + "/disable"

	resp := f.api.Post(path, auth, map[string]any{"code": "123456"})
	expectProblem(t, "not enabled", resp, http.StatusConflict, CodeNotEnabled)

	secret, codes := f.confirm(t, auth)
	mails := len(f.jobs.emails())

	// Exactly one proof.
	resp = f.api.Post(path, auth, map[string]any{})
	expectProblem(t, "no proof", resp, http.StatusBadRequest, CodeInvalidRequest)
	resp = f.api.Post(path, auth, map[string]any{"code": code(t, secret), "backup_code": codes[0]})
	expectProblem(t, "both proofs", resp, http.StatusBadRequest, CodeInvalidRequest)
	if resp := f.api.Post(path, auth, map[string]any{"code": "12345"}); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("malformed code: %d", resp.Code)
	}

	// Wrong proofs change nothing.
	resp = f.api.Post(path, auth, map[string]any{"code": wrongCode(code(t, secret))})
	expectProblem(t, "wrong code", resp, http.StatusUnauthorized, CodeInvalidTOTP)
	resp = f.api.Post(path, auth, map[string]any{"backup_code": "aaaa-aaaa"})
	expectProblem(t, "wrong backup code", resp, http.StatusUnauthorized, CodeInvalidTOTP)
	if _, err := f.q.UseBackupCode(f.ctx, db.UseBackupCodeParams{UserID: u.ID, CodeHash: twofactor.HashBackupCode(u.ID, codes[0])}); err != nil {
		t.Fatal(err)
	}
	resp = f.api.Post(path, auth, map[string]any{"backup_code": codes[0]})
	expectProblem(t, "spent backup code", resp, http.StatusUnauthorized, CodeInvalidTOTP)
	if st := f.status(t, auth); !st.Enabled || st.BackupCodesRemaining != 9 {
		t.Fatalf("after refusals: %+v", st)
	}
	if len(f.events(t, u.ID, audit.TOTPDisabled)) != 0 || len(f.jobs.emails()) != mails {
		t.Fatal("no audit or email for a refused disable")
	}

	// A revoked session cannot disable, even with a right code.
	f.revokeSessions(t, u.ID)
	resp = f.api.Post(path, auth, map[string]any{"code": code(t, secret)})
	expectProblem(t, "revoked session", resp, http.StatusUnauthorized, CodeSessionExpired)
	if _, err := f.q.GetTOTPForUser(f.ctx, u.ID); err != nil {
		t.Fatal("2FA must still be on")
	}

	// Disable with a TOTP code from a current session.
	tok, err := f.sessions.Create(f.ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		t.Fatal(err)
	}
	auth = "Authorization: Bearer " + tok.AccessToken
	resp = f.api.Post(path, auth, map[string]any{"code": code(t, secret)})
	if resp.Code != http.StatusNoContent {
		t.Fatalf("disable: %d %s", resp.Code, resp.Body)
	}
	if _, err := f.q.GetTOTPForUser(f.ctx, u.ID); err == nil {
		t.Fatal("secret must be deleted")
	}
	if n, err := f.q.CountUnusedBackupCodesForUser(f.ctx, u.ID); err != nil || n != 0 {
		t.Fatalf("backup codes left = %d, %v", n, err)
	}
	var left int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM backup_codes WHERE user_id = $1`, u.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("used backup codes must be deleted too: %d %v", left, err)
	}
	evs := f.events(t, u.ID, audit.TOTPDisabled)
	if len(evs) != 1 || !strings.Contains(string(evs[0].Metadata), `"totp"`) {
		t.Fatalf("totp.disabled events = %+v", evs)
	}
	all := f.jobs.emails()
	if len(all) != mails+1 {
		t.Fatalf("emails = %d, want %d", len(all), mails+1)
	}
	if m := all[len(all)-1]; m.To != "disable@example.com" || m.Template != email.TemplateSecurityChange || m.Data["change"] != email.SecurityChangeTOTPDisabled {
		t.Fatalf("email = %+v", m)
	}
	if st := f.status(t, auth); st.Enabled {
		t.Fatalf("after disable: %+v", st)
	}
	resp = f.api.Post(path, auth, map[string]any{"code": code(t, secret)})
	expectProblem(t, "disable twice", resp, http.StatusConflict, CodeNotEnabled)

	// Turn it on again and off with a backup code, typed loosely.
	_, codes = f.confirm(t, auth)
	loose := strings.ToUpper(strings.Replace(codes[3], "-", " ", 1))
	resp = f.api.Post(path, auth, map[string]any{"backup_code": loose})
	if resp.Code != http.StatusNoContent {
		t.Fatalf("disable with backup code: %d %s", resp.Code, resp.Body)
	}
	evs = f.events(t, u.ID, audit.TOTPDisabled)
	if len(evs) != 2 {
		t.Fatalf("totp.disabled events = %d, want 2", len(evs))
	}
	var methods []string
	for _, e := range evs {
		var meta map[string]any
		if err := json.Unmarshal(e.Metadata, &meta); err != nil {
			t.Fatal(err)
		}
		methods = append(methods, meta["method"].(string))
		if strings.Contains(string(e.Metadata), codes[3]) {
			t.Fatal("audit metadata must not hold the backup code")
		}
	}
	if !strings.Contains(strings.Join(methods, ","), "backup_code") {
		t.Fatalf("methods = %v", methods)
	}
	if st := f.status(t, auth); st.Enabled {
		t.Fatalf("after backup-code disable: %+v", st)
	}
}

func TestTwoFactorRegenerateBackupCodes(t *testing.T) {
	f := setupTwoFactor(t)
	u, auth := f.signIn(t, "regen@example.com")
	path := TwoFactorPrefix + "/backup-codes/regenerate"

	resp := f.api.Post(path, auth, map[string]any{"code": "123456"})
	expectProblem(t, "not enabled", resp, http.StatusConflict, CodeNotEnabled)
	// A pending secret is not enabled either.
	secret, _ := f.enable(t, auth)
	resp = f.api.Post(path, auth, map[string]any{"code": code(t, secret)})
	expectProblem(t, "pending", resp, http.StatusConflict, CodeNotEnabled)

	secret, old := f.confirm(t, auth)
	mails := len(f.jobs.emails())
	for _, c := range []string{"", "12345", "abcdef"} {
		if resp := f.api.Post(path, auth, map[string]any{"code": c}); resp.Code != http.StatusUnprocessableEntity {
			t.Errorf("code %q: status = %d", c, resp.Code)
		}
	}
	resp = f.api.Post(path, auth, map[string]any{"code": wrongCode(code(t, secret))})
	expectProblem(t, "wrong code", resp, http.StatusUnauthorized, CodeInvalidTOTP)
	if len(f.jobs.emails()) != mails {
		t.Fatal("no email for a refused regenerate")
	}
	// Spend one old code: regenerating restores a full set.
	if _, err := f.q.UseBackupCode(f.ctx, db.UseBackupCodeParams{UserID: u.ID, CodeHash: twofactor.HashBackupCode(u.ID, old[0])}); err != nil {
		t.Fatal(err)
	}

	resp = f.api.Post(path, auth, map[string]any{"code": code(t, secret)})
	if resp.Code != http.StatusOK {
		t.Fatalf("regenerate: %d %s", resp.Code, resp.Body)
	}
	fresh := backupCodes(t, resp.Body.Bytes())
	if len(fresh) != 10 {
		t.Fatalf("got %d codes, want 10", len(fresh))
	}
	oldSet := map[string]bool{}
	for _, c := range old {
		oldSet[c] = true
	}
	for _, c := range fresh {
		if oldSet[c] {
			t.Fatalf("new code %q repeats an old one", c)
		}
	}
	if st := f.status(t, auth); !st.Enabled || st.BackupCodesRemaining != 10 {
		t.Fatalf("after regenerate: %+v", st)
	}
	// Old codes no longer work; new ones do.
	if _, err := f.q.UseBackupCode(f.ctx, db.UseBackupCodeParams{UserID: u.ID, CodeHash: twofactor.HashBackupCode(u.ID, old[1])}); err == nil {
		t.Fatal("an old code must be invalidated")
	}
	if _, err := f.q.UseBackupCode(f.ctx, db.UseBackupCodeParams{UserID: u.ID, CodeHash: twofactor.HashBackupCode(u.ID, fresh[0])}); err != nil {
		t.Fatalf("a new code must be stored: %v", err)
	}
	all := f.jobs.emails()
	if len(all) != mails+1 {
		t.Fatalf("emails = %d, want %d", len(all), mails+1)
	}
	if m := all[len(all)-1]; m.To != "regen@example.com" || m.Template != email.TemplateSecurityChange || m.Data["change"] != email.SecurityChangeBackupCodesReset {
		t.Fatalf("email = %+v", m)
	}
	// 2FA itself is untouched.
	if row, err := f.q.GetTOTPForUser(f.ctx, u.ID); err != nil || row.ConfirmedAt == nil {
		t.Fatalf("2FA must stay on: %v", err)
	}

	// A revoked session cannot regenerate.
	f.revokeSessions(t, u.ID)
	resp = f.api.Post(path, auth, map[string]any{"code": code(t, secret)})
	expectProblem(t, "revoked session", resp, http.StatusUnauthorized, CodeSessionExpired)
}
