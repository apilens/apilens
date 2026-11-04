//go:build integration

package identity

import (
	"encoding/json"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// exchangeFixture is the 2FA fixture plus email sign-in and the exchange
// endpoint, with pre-auth tokens in a real Valkey.
type exchangeFixture struct {
	*twoFactorFixture
	codes *emailauth.Service
	vk    valkey.Client
}

// totpCode is the current code of secret (code is shadowed below).
func totpCode(t *testing.T, secret string) string {
	t.Helper()
	return code(t, secret)
}

func setupExchange(t *testing.T) *exchangeFixture {
	t.Helper()
	f := setupTwoFactor(t)
	vk, err := cache.Connect(f.ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	logger := testutil.Logger(t)
	limiter, err := ratelimit.New(vk, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	codes := emailauth.New(emailauth.NewStore(f.pool), emailauth.Options{})
	cfg := config.IdentityConfig{PreAuthTTL: 5 * time.Minute, PublicUIURL: "http://localhost:3000"}
	cfg.RateLimits.CodeVerifyPerEmail = config.RateLimit{Limit: 100, Window: time.Minute}
	store := NewValkeyPreAuthStore(vk)
	NewEmailVerify(cfg, EmailVerifyDeps{
		Codes:    codes,
		Users:    NewPGSignInUsers(f.pool),
		Sessions: f.sessions,
		PreAuth:  store,
		Audit:    audit.New(f.pool),
	}, limiter, logger).Register(f.api)
	NewTwoFactorExchange(TwoFactorExchangeDeps{
		PreAuth:   store,
		TwoFactor: f.svc,
		Users:     NewPGSignInUsers(f.pool),
		Sessions:  f.sessions,
		Audit:     audit.New(f.pool),
	}, logger).Register(f.api)
	return &exchangeFixture{twoFactorFixture: f, codes: codes, vk: vk}
}

// emailSignIn signs addr in with an emailed code and returns the
// 2fa_required answer.
func (f *exchangeFixture) emailSignIn(t *testing.T, addr string) SignInResponse {
	t.Helper()
	next := "/acme"
	iss, err := f.codes.Issue(f.ctx, addr, emailauth.IntentSignIn, emailauth.IssueOptions{NextPath: &next})
	if err != nil {
		t.Fatal(err)
	}
	resp := f.api.Post(AuthPrefix+"/email/verify", map[string]any{"email": addr, "code": iss.Code, "remember": true})
	if resp.Code != http.StatusOK {
		t.Fatalf("email verify: %d %s", resp.Code, resp.Body)
	}
	var out SignInResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != TwoFactorRequiredStatus || out.PreAuthToken == "" || out.AccessToken != "" || out.Next != "/acme" {
		t.Fatalf("email verify body = %+v, want 2fa_required", out)
	}
	return out
}

func (f *exchangeFixture) exchange(t *testing.T, body map[string]any) (int, SignInResponse, ErrCode) {
	t.Helper()
	resp := f.api.Post(TwoFactorPrefix+"/exchange", body)
	if resp.Code != http.StatusOK {
		return resp.Code, SignInResponse{}, problemCode(t, resp.Body.Bytes())
	}
	var out SignInResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return resp.Code, out, ""
}

func TestTwoFactorExchangeEmailFlow(t *testing.T) {
	f := setupExchange(t)
	const addr = "exchange@example.com"
	u, auth := f.signIn(t, addr)
	secret, backups := f.confirm(t, auth)

	t.Run("totp", func(t *testing.T) {
		pre := f.emailSignIn(t, addr)

		// The pre-auth token is not a JWT: no other endpoint takes it.
		bearer := "Authorization: Bearer " + pre.PreAuthToken
		for _, path := range []string{MePath, TwoFactorPrefix + "/status"} {
			if resp := f.api.Get(path, bearer); resp.Code != http.StatusUnauthorized {
				t.Fatalf("GET %s with the pre-auth token: %d %s", path, resp.Code, resp.Body)
			}
		}

		status, out, code := f.exchange(t, map[string]any{"pre_auth_token": pre.PreAuthToken, "code": "000000"})
		if status != http.StatusBadRequest || code != CodeInvalidCode {
			t.Fatalf("wrong code: %d %s", status, code)
		}
		status, out, code = f.exchange(t, map[string]any{"pre_auth_token": pre.PreAuthToken, "code": totpCode(t, secret)})
		if status != http.StatusOK || out.AccessToken == "" || out.RefreshToken == "" || out.User == nil ||
			out.User.ID != u.ID.String() || out.Next != "/acme" || out.Status != "" {
			t.Fatalf("exchange: %d %+v %s", status, out, code)
		}
		resp := f.api.Get(MePath, "Authorization: Bearer "+out.AccessToken)
		if resp.Code != http.StatusOK {
			t.Fatalf("me: %d %s", resp.Code, resp.Body)
		}
		if m := decodeMe(t, resp.Body.Bytes()); !slices.Equal(m.AMR, []string{token.AMREmail, token.AMRTOTP}) {
			t.Fatalf("amr = %v", m.AMR)
		}
		var remember bool
		if err := f.pool.QueryRow(f.ctx, `SELECT remember FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, u.ID).Scan(&remember); err != nil || !remember {
			t.Fatalf("remember = %v (%v)", remember, err)
		}
		// The token is single use.
		if status, _, code := f.exchange(t, map[string]any{"pre_auth_token": pre.PreAuthToken, "code": totpCode(t, secret)}); status != http.StatusUnauthorized || code != CodeInvalidToken {
			t.Fatalf("reuse: %d %s", status, code)
		}
		ok := f.events(t, u.ID, audit.LoginSucceeded)
		var meta map[string]any
		if err := json.Unmarshal(ok[0].Metadata, &meta); err != nil {
			t.Fatal(err)
		}
		if meta["method"] != "email" || meta["second_factor"] != "totp" {
			t.Fatalf("login.succeeded metadata = %v", meta)
		}
	})

	t.Run("backup code", func(t *testing.T) {
		pre := f.emailSignIn(t, addr)
		status, out, code := f.exchange(t, map[string]any{"pre_auth_token": pre.PreAuthToken, "backup_code": backups[0]})
		if status != http.StatusOK || out.AccessToken == "" {
			t.Fatalf("exchange: %d %s", status, code)
		}
		resp := f.api.Get(MePath, "Authorization: Bearer "+out.AccessToken)
		if resp.Code != http.StatusOK {
			t.Fatalf("me: %d %s", resp.Code, resp.Body)
		}
		if m := decodeMe(t, resp.Body.Bytes()); !slices.Equal(m.AMR, []string{token.AMREmail, token.AMRBackupCode}) {
			t.Fatalf("amr = %v", m.AMR)
		}
		var used *time.Time
		if err := f.pool.QueryRow(f.ctx, `SELECT used_at FROM backup_codes WHERE user_id = $1 AND used_at IS NOT NULL`, u.ID).Scan(&used); err != nil || used == nil {
			t.Fatalf("used_at = %v (%v)", used, err)
		}
		// A spent backup code does not work twice.
		pre = f.emailSignIn(t, addr)
		if status, _, code := f.exchange(t, map[string]any{"pre_auth_token": pre.PreAuthToken, "backup_code": backups[0]}); status != http.StatusBadRequest || code != CodeInvalidCode {
			t.Fatalf("spent backup code: %d %s", status, code)
		}
	})

	t.Run("five attempts", func(t *testing.T) {
		pre := f.emailSignIn(t, addr)
		for i := 1; i < PreAuthMaxAttempts; i++ {
			if status, _, code := f.exchange(t, map[string]any{"pre_auth_token": pre.PreAuthToken, "code": "000000"}); status != http.StatusBadRequest || code != CodeInvalidCode {
				t.Fatalf("attempt %d: %d %s", i, status, code)
			}
		}
		// The attempts are counted in Valkey; the TTL is kept.
		ttl, err := f.vk.Do(f.ctx, f.vk.B().Ttl().Key(PreAuthKey(pre.PreAuthToken)).Build()).AsInt64()
		if err != nil || ttl <= 0 || ttl > 300 {
			t.Fatalf("ttl = %d (%v)", ttl, err)
		}
		if status, _, code := f.exchange(t, map[string]any{"pre_auth_token": pre.PreAuthToken, "code": "000000"}); status != http.StatusTooManyRequests || code != CodeTooManyAttempts {
			t.Fatalf("fifth attempt: %d %s", status, code)
		}
		if n, err := f.vk.Do(f.ctx, f.vk.B().Exists().Key(PreAuthKey(pre.PreAuthToken)).Build()).AsInt64(); err != nil || n != 0 {
			t.Fatalf("token kept after exhaustion: %d (%v)", n, err)
		}
		if status, _, code := f.exchange(t, map[string]any{"pre_auth_token": pre.PreAuthToken, "code": totpCode(t, secret)}); status != http.StatusUnauthorized || code != CodeInvalidToken {
			t.Fatalf("after exhaustion: %d %s", status, code)
		}
	})

	t.Run("concurrent guesses are capped", func(t *testing.T) {
		pre := f.emailSignIn(t, addr)
		var (
			wg      sync.WaitGroup
			mu      sync.Mutex
			counted int
		)
		for range 20 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				resp := f.api.Post(TwoFactorPrefix+"/exchange", map[string]any{"pre_auth_token": pre.PreAuthToken, "code": "000000"})
				if resp.Code != http.StatusUnauthorized {
					mu.Lock()
					counted++
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		if counted != PreAuthMaxAttempts {
			t.Fatalf("checked guesses = %d, want %d", counted, PreAuthMaxAttempts)
		}
	})
}
