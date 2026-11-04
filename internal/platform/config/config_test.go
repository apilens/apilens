package config

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// testKEK is a valid base64 32-byte key encryption key for tests only.
var testKEK = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, KeyEncryptionKeySize))

var kekEnv = "APILENS_IDENTITY__KEY_ENCRYPTION_KEY=" + testKEK

func TestDefaultsAreValid(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cfg.Target, []string{"all"}) {
		t.Fatalf("target = %v", cfg.Target)
	}
	if cfg.Sink.FlushInterval != 250*time.Millisecond {
		t.Fatalf("flush interval = %v", cfg.Sink.FlushInterval)
	}
	if cfg.Valkey.Enabled() {
		t.Fatal("valkey should be disabled by default")
	}
}

func TestPrecedenceFileEnvFlags(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	yaml := "server:\n  addr: \":9000\"\npostgres:\n  max_conns: 5\nlog:\n  level: debug\n"
	if err := os.WriteFile(path, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	env := []string{
		"APILENS_POSTGRES__MAX_CONNS=7",
		"APILENS_CLICKHOUSE__ADDR=ch1:9000, ch2:9000",
		"APILENS_VALKEY__ADDR=valkey:6379",
		"APILENS_SINK__FLUSH_INTERVAL=1s",
		"UNRELATED=1",
		kekEnv,
	}
	cfg, err := Load(path, env, map[string]any{"log.level": "warn"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Addr != ":9000" {
		t.Errorf("file not applied: addr=%q", cfg.Server.Addr)
	}
	if cfg.Postgres.MaxConns != 7 {
		t.Errorf("env should beat file: max_conns=%d", cfg.Postgres.MaxConns)
	}
	if cfg.Log.Level != "warn" {
		t.Errorf("flags should beat everything: level=%q", cfg.Log.Level)
	}
	if !slices.Equal(cfg.ClickHouse.Addr, []string{"ch1:9000", "ch2:9000"}) {
		t.Errorf("list env not split: %v", cfg.ClickHouse.Addr)
	}
	if !cfg.Valkey.Enabled() {
		t.Error("valkey should be enabled")
	}
	if cfg.Sink.FlushInterval != time.Second {
		t.Errorf("duration not parsed: %v", cfg.Sink.FlushInterval)
	}
}

func TestValidationErrorsAreReported(t *testing.T) {
	env := []string{"APILENS_LOG__LEVEL=loud", "APILENS_SINK__MODE=kafka", "APILENS_SINK__ACK=never"}
	_, err := Load("", env, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"log.level", "kafka is not available", "sink.ack"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing %q", err, want)
		}
	}
}

func TestMissingFile(t *testing.T) {
	if _, err := Load("/does/not/exist.yaml", nil, nil); err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestIdentityDefaults(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := cfg.Identity
	checks := []struct {
		name      string
		got, want time.Duration
	}{
		{"access_token_ttl", id.AccessTokenTTL, 15 * time.Minute},
		{"refresh_token_ttl", id.RefreshTokenTTL, 30 * 24 * time.Hour},
		{"refresh_token_ttl_short", id.RefreshTokenTTLShort, 24 * time.Hour},
		{"email_code_ttl", id.EmailCodeTTL, 15 * time.Minute},
		{"pre_auth_ttl", id.PreAuthTTL, 5 * time.Minute},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}
	if id.EmailCodeMaxAttempts != 5 {
		t.Errorf("email_code_max_attempts = %d", id.EmailCodeMaxAttempts)
	}
	if id.Issuer != "http://localhost:8080" || id.PublicUIURL != "http://localhost:3000" || id.CookieDomain != "" {
		t.Errorf("urls = %q %q %q", id.Issuer, id.PublicUIURL, id.CookieDomain)
	}
	if id.WebAuthn.RPID != "localhost" || id.WebAuthn.RPName != "APILens" ||
		!slices.Equal(id.WebAuthn.Origins, []string{"http://localhost:3000"}) {
		t.Errorf("webauthn = %+v", id.WebAuthn)
	}
	kek, err := id.KEK()
	if err != nil || len(kek) != KeyEncryptionKeySize {
		t.Fatalf("KEK() = %d bytes, %v", len(kek), err)
	}
	if !cfg.IdentityEnabled() {
		t.Error("target all should enable identity")
	}
}

func TestIdentityEnv(t *testing.T) {
	env := []string{
		kekEnv,
		"APILENS_IDENTITY__ISSUER=https://api.example.com",
		"APILENS_IDENTITY__PUBLIC_UI_URL=https://app.example.com",
		"APILENS_IDENTITY__COOKIE_DOMAIN=example.com",
		"APILENS_IDENTITY__ACCESS_TOKEN_TTL=5m",
		"APILENS_IDENTITY__EMAIL_CODE_MAX_ATTEMPTS=3",
		"APILENS_IDENTITY__WEBAUTHN__RP_ID=example.com",
		"APILENS_IDENTITY__WEBAUTHN__ORIGINS=https://app.example.com, https://example.com",
	}
	cfg, err := Load("", env, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := cfg.Identity
	if id.Issuer != "https://api.example.com" || id.PublicUIURL != "https://app.example.com" || id.CookieDomain != "example.com" {
		t.Errorf("urls = %q %q %q", id.Issuer, id.PublicUIURL, id.CookieDomain)
	}
	if id.AccessTokenTTL != 5*time.Minute || id.EmailCodeMaxAttempts != 3 || id.WebAuthn.RPID != "example.com" {
		t.Errorf("identity = %+v", id)
	}
	if !slices.Equal(id.WebAuthn.Origins, []string{"https://app.example.com", "https://example.com"}) {
		t.Errorf("origins not split: %v", id.WebAuthn.Origins)
	}
}

func TestIdentityKeyEncryptionKey(t *testing.T) {
	short := base64.StdEncoding.EncodeToString(make([]byte, 16))
	tests := []struct {
		name    string
		env     []string
		flags   map[string]any
		wantErr string
	}{
		{name: "missing with all", wantErr: "identity.key_encryption_key is not set"},
		{name: "missing with identity", flags: map[string]any{"target": []string{"identity"}}, wantErr: "required when target includes identity"},
		{name: "short", env: []string{"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=" + short}, wantErr: "decodes to 16 bytes, want 32"},
		{name: "not base64", env: []string{"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=not*base64!"}, wantErr: "not valid base64"},
		{name: "missing without identity", flags: map[string]any{"target": []string{"edge", "query"}}},
		{name: "invalid without identity", env: []string{"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=" + short}, flags: map[string]any{"target": []string{"edge"}}, wantErr: "decodes to 16 bytes"},
		{name: "valid", env: []string{kekEnv}, flags: map[string]any{"target": []string{"identity"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load("", tt.env, tt.flags)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestIdentityValidation(t *testing.T) {
	env := []string{
		kekEnv,
		"APILENS_IDENTITY__ISSUER=not-a-url",
		"APILENS_IDENTITY__PUBLIC_UI_URL=ftp://app.example.com",
		"APILENS_IDENTITY__ACCESS_TOKEN_TTL=0s",
		"APILENS_IDENTITY__REFRESH_TOKEN_TTL=1h",
		"APILENS_IDENTITY__EMAIL_CODE_MAX_ATTEMPTS=0",
		"APILENS_IDENTITY__WEBAUTHN__ORIGINS=app.example.com",
		"APILENS_IDENTITY__WEBAUTHN__RP_ID=",
	}
	_, err := Load("", env, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{
		"identity.issuer", "identity.public_ui_url", "access_token_ttl", "refresh_token_ttl_short must not exceed",
		"email_code_max_attempts", "identity.webauthn.origins", "rp_id",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing %q", err, want)
		}
	}
}

func TestWebAuthnRPIDValidation(t *testing.T) {
	tests := []struct {
		rpID    string
		origins string
		wantErr string
	}{
		{rpID: "localhost", origins: "http://localhost:3000"},
		{rpID: "example.com", origins: "https://example.com,https://app.example.com:8443"},
		{rpID: "app.example.com", origins: "https://app.example.com"},
		{rpID: "example.co.uk", origins: "https://app.example.co.uk"},
		{rpID: "corp.internal", origins: "https://apilens.corp.internal"},
		{rpID: "example.com", origins: "https://example.org", wantErr: `not a registrable domain suffix of origin "https://example.org"`},
		{rpID: "example.com", origins: "https://notexample.com", wantErr: "not a registrable domain suffix"},
		{rpID: "app.example.com", origins: "https://example.com", wantErr: "not a registrable domain suffix"},
		{rpID: "example.com", origins: "https://app.example.com,https://evil.test", wantErr: `origin "https://evil.test"`},
		{rpID: "co.uk", origins: "https://example.co.uk", wantErr: "not a registrable domain suffix"},
		{rpID: "com", origins: "https://example.com", wantErr: "not a registrable domain suffix"},
		{rpID: "localhost", origins: "http://127.0.0.1:3000", wantErr: "not a registrable domain suffix"},
		{rpID: "127.0.0.1", origins: "http://127.0.0.1:3000", wantErr: "want a lowercase domain name"},
		{rpID: "https://example.com", origins: "https://example.com", wantErr: "want a lowercase domain name"},
		{rpID: "example.com:443", origins: "https://example.com", wantErr: "want a lowercase domain name"},
		{rpID: "Example.com", origins: "https://example.com", wantErr: "want a lowercase domain name"},
		{rpID: ".example.com", origins: "https://example.com", wantErr: "want a lowercase domain name"},
	}
	for _, tt := range tests {
		t.Run(tt.rpID+" "+tt.origins, func(t *testing.T) {
			_, err := Load("", []string{
				kekEnv,
				"APILENS_IDENTITY__WEBAUTHN__RP_ID=" + tt.rpID,
				"APILENS_IDENTITY__WEBAUTHN__ORIGINS=" + tt.origins,
			}, nil)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestIdentityCORSOrigins(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Identity.CORSOrigins) != 0 {
		t.Fatalf("cors_origins should default to empty, got %v", cfg.Identity.CORSOrigins)
	}

	cfg, err = Load("", []string{kekEnv, "APILENS_IDENTITY__CORS_ORIGINS=https://app.example.com, http://localhost:3000"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cfg.Identity.CORSOrigins, []string{"https://app.example.com", "http://localhost:3000"}) {
		t.Fatalf("cors_origins = %v", cfg.Identity.CORSOrigins)
	}

	for _, bad := range []string{"*", "app.example.com", "https://app.example.com/path", "https://app.example.com?x=1", "null"} {
		_, err := Load("", []string{kekEnv, "APILENS_IDENTITY__CORS_ORIGINS=" + bad}, nil)
		if err == nil || !strings.Contains(err.Error(), "identity.cors_origins") {
			t.Errorf("cors_origins=%q: err = %v", bad, err)
		}
	}
}

func TestJobsConfig(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Jobs.Enabled || cfg.Jobs.MaxWorkers != 10 || cfg.Jobs.MetricsInterval != 15*time.Second {
		t.Errorf("jobs defaults = %+v", cfg.Jobs)
	}

	cfg, err = Load("", []string{kekEnv, "APILENS_JOBS__ENABLED=false", "APILENS_JOBS__MAX_WORKERS=3"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Jobs.Enabled || cfg.Jobs.MaxWorkers != 3 {
		t.Errorf("jobs from env = %+v", cfg.Jobs)
	}

	_, err = Load("", []string{kekEnv, "APILENS_JOBS__MAX_WORKERS=0", "APILENS_JOBS__METRICS_INTERVAL=0s"}, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"jobs.max_workers", "jobs.metrics_interval"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing %q", err, want)
		}
	}
}

func TestIdentityRateLimitDefaults(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	rl := cfg.Identity.RateLimits
	checks := []struct {
		name      string
		got, want RateLimit
	}{
		{"email_start_per_email", rl.EmailStartPerEmail, RateLimit{5, 15 * time.Minute}},
		{"email_start_per_ip", rl.EmailStartPerIP, RateLimit{20, 15 * time.Minute}},
		{"code_verify_per_email", rl.CodeVerifyPerEmail, RateLimit{10, 15 * time.Minute}},
		{"refresh_per_ip", rl.RefreshPerIP, RateLimit{60, time.Minute}},
		{"second_factor_per_user", rl.SecondFactorPerUser, RateLimit{10, 15 * time.Minute}},
		{"oauth_start_per_ip", rl.OAuthStartPerIP, RateLimit{30, 15 * time.Minute}},
		{"sso_lookup_per_ip", rl.SSOLookupPerIP, RateLimit{60, 15 * time.Minute}},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %+v, want %+v", c.name, c.got, c.want)
		}
	}
	if len(rl.TrustedProxies) != 0 {
		t.Errorf("trusted_proxies = %v, want empty", rl.TrustedProxies)
	}
}

func TestIdentityRateLimitEnv(t *testing.T) {
	cfg, err := Load("", []string{
		kekEnv,
		"APILENS_IDENTITY__RATE_LIMITS__REFRESH_PER_IP__LIMIT=120",
		"APILENS_IDENTITY__RATE_LIMITS__REFRESH_PER_IP__WINDOW=2m",
		"APILENS_IDENTITY__RATE_LIMITS__TRUSTED_PROXIES=10.0.0.0/8, 192.168.1.1",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	rl := cfg.Identity.RateLimits
	if rl.RefreshPerIP != (RateLimit{120, 2 * time.Minute}) {
		t.Errorf("refresh_per_ip = %+v", rl.RefreshPerIP)
	}
	if !slices.Equal(rl.TrustedProxies, []string{"10.0.0.0/8", "192.168.1.1"}) {
		t.Errorf("trusted_proxies not split: %v", rl.TrustedProxies)
	}
}

func TestIdentityRateLimitValidation(t *testing.T) {
	tests := []struct {
		env     string
		wantErr string
	}{
		{"APILENS_IDENTITY__RATE_LIMITS__EMAIL_START_PER_IP__LIMIT=0", "identity.rate_limits.email_start_per_ip"},
		{"APILENS_IDENTITY__RATE_LIMITS__CODE_VERIFY_PER_EMAIL__WINDOW=10ms", "identity.rate_limits.code_verify_per_email"},
		{"APILENS_IDENTITY__RATE_LIMITS__TRUSTED_PROXIES=not-an-ip", "identity.rate_limits.trusted_proxies"},
	}
	for _, tt := range tests {
		_, err := Load("", []string{kekEnv, tt.env}, nil)
		if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
			t.Errorf("%s: err = %v, want %q", tt.env, err, tt.wantErr)
		}
	}
}

func TestAuthzDefaults(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Authz.Enabled() {
		t.Error("authz should be disabled by default")
	}
	if cfg.Authz.CacheTTL != 5*time.Second || cfg.Authz.Insecure {
		t.Errorf("authz = %+v", cfg.Authz)
	}
}

func TestAuthzEnv(t *testing.T) {
	env := []string{
		kekEnv,
		"APILENS_AUTHZ__ENDPOINT=spicedb:50051",
		"APILENS_AUTHZ__PRESHARED_KEY=secret",
		"APILENS_AUTHZ__INSECURE=true",
		"APILENS_AUTHZ__CACHE_TTL=0s",
	}
	cfg, err := Load("", env, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := AuthzConfig{Endpoint: "spicedb:50051", PresharedKey: "secret", Insecure: true}
	if cfg.Authz != want || !cfg.Authz.Enabled() {
		t.Errorf("authz = %+v, want %+v", cfg.Authz, want)
	}
}

func TestIdentityOAuth(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Identity.OAuth.Google.Enabled() || cfg.Identity.OAuth.GitHub.Enabled() {
		t.Fatalf("oauth providers should be disabled by default: %+v", cfg.Identity.OAuth)
	}

	cfg, err = Load("", []string{
		kekEnv,
		"APILENS_IDENTITY__ISSUER=https://api.example.com/",
		"APILENS_IDENTITY__OAUTH__GOOGLE__CLIENT_ID=g-id",
		"APILENS_IDENTITY__OAUTH__GOOGLE__CLIENT_SECRET=g-secret",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := cfg.Identity.OAuth.Google
	if !g.Enabled() || g.ClientID != "g-id" || g.ClientSecret != "g-secret" {
		t.Errorf("google = %+v", g)
	}
	if cfg.Identity.OAuth.GitHub.Enabled() {
		t.Error("github should stay disabled")
	}
	for provider, want := range map[string]string{
		OAuthProviderGoogle: "https://api.example.com/api/v1/auth/oauth/google/callback",
		OAuthProviderGitHub: "https://api.example.com/api/v1/auth/oauth/github/callback",
	} {
		if got := cfg.Identity.OAuthRedirectURI(provider); got != want {
			t.Errorf("redirect uri = %q, want %q", got, want)
		}
	}
}

func TestIdentityOAuthValidation(t *testing.T) {
	tests := []struct {
		name    string
		env     []string
		wantErr string
	}{
		{name: "google id without secret", env: []string{"APILENS_IDENTITY__OAUTH__GOOGLE__CLIENT_ID=g-id"}, wantErr: "identity.oauth.google.client_secret is required"},
		{name: "github id without secret", env: []string{"APILENS_IDENTITY__OAUTH__GITHUB__CLIENT_ID=gh-id"}, wantErr: "identity.oauth.github.client_secret is required"},
		{name: "github secret without id", env: []string{"APILENS_IDENTITY__OAUTH__GITHUB__CLIENT_SECRET=s"}, wantErr: "identity.oauth.github.client_id is required"},
		{name: "github complete", env: []string{"APILENS_IDENTITY__OAUTH__GITHUB__CLIENT_ID=gh-id", "APILENS_IDENTITY__OAUTH__GITHUB__CLIENT_SECRET=s"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load("", append([]string{kekEnv}, tt.env...), nil)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestAuthzValidation(t *testing.T) {
	tests := []struct {
		name    string
		env     []string
		wantErr string
	}{
		{name: "missing key", env: []string{"APILENS_AUTHZ__ENDPOINT=spicedb:50051"}, wantErr: "authz.preshared_key is required"},
		{name: "no port", env: []string{"APILENS_AUTHZ__ENDPOINT=spicedb", "APILENS_AUTHZ__PRESHARED_KEY=k"}, wantErr: "want host:port"},
		{name: "negative ttl", env: []string{"APILENS_AUTHZ__CACHE_TTL=-1s"}, wantErr: "authz.cache_ttl"},
		{name: "key without endpoint", env: []string{"APILENS_AUTHZ__PRESHARED_KEY=k"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load("", append([]string{kekEnv}, tt.env...), nil)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestEmailDefaults(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	e := cfg.Email
	if e.Provider != EmailProviderLog || !e.LogOnly() {
		t.Errorf("provider = %q, want log by default", e.Provider)
	}
	if e.Port != 587 || e.TLS != EmailTLSStartTLS || e.Timeout != 10*time.Second {
		t.Errorf("defaults = port %d, tls %q, timeout %v", e.Port, e.TLS, e.Timeout)
	}
	if e.From != "" || e.Host != "" {
		t.Errorf("from/host should be empty by default: %+v", e)
	}
}

func TestEmailSMTPEnv(t *testing.T) {
	env := []string{
		kekEnv,
		"APILENS_EMAIL__PROVIDER=smtp",
		"APILENS_EMAIL__HOST=smtp.example.com",
		"APILENS_EMAIL__PORT=465",
		"APILENS_EMAIL__USERNAME=apikey",
		"APILENS_EMAIL__PASSWORD=secret",
		"APILENS_EMAIL__FROM=APILens <no-reply@example.com>",
		"APILENS_EMAIL__REPLY_TO=support@example.com",
		"APILENS_EMAIL__TLS=tls",
		"APILENS_EMAIL__TIMEOUT=5s",
	}
	cfg, err := Load("", env, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := EmailConfig{
		Provider: EmailProviderSMTP, Host: "smtp.example.com", Port: 465,
		Username: "apikey", Password: "secret",
		From: "APILens <no-reply@example.com>", ReplyTo: "support@example.com",
		TLS: EmailTLSImplicit, Timeout: 5 * time.Second,
	}
	if cfg.Email != want {
		t.Errorf("email = %+v, want %+v", cfg.Email, want)
	}
	if cfg.Email.LogOnly() {
		t.Error("smtp provider reported as log-only")
	}
}

func TestEmailValidation(t *testing.T) {
	smtp := []string{"APILENS_EMAIL__PROVIDER=smtp", "APILENS_EMAIL__HOST=smtp.example.com", "APILENS_EMAIL__FROM=no-reply@example.com"}
	with := func(extra ...string) []string { return append(slices.Clone(smtp), extra...) }
	for _, tc := range []struct {
		name string
		env  []string
		want string // empty: valid
	}{
		{"smtp ok", smtp, ""},
		{"smtp without from", []string{"APILENS_EMAIL__PROVIDER=smtp", "APILENS_EMAIL__HOST=smtp.example.com"}, "email.from is required"},
		{"smtp without host", []string{"APILENS_EMAIL__PROVIDER=smtp", "APILENS_EMAIL__FROM=a@example.com"}, "email.host is required"},
		{"log without from", []string{"APILENS_EMAIL__PROVIDER=log"}, ""},
		{"unknown provider", []string{"APILENS_EMAIL__PROVIDER=sendgrid"}, "email.provider"},
		{"bad tls", with("APILENS_EMAIL__TLS=ssl"), "email.tls"},
		{"tls none", with("APILENS_EMAIL__TLS=none", "APILENS_EMAIL__PORT=25"), ""},
		{"bad port", with("APILENS_EMAIL__PORT=70000"), "email.port"},
		{"zero timeout", with("APILENS_EMAIL__TIMEOUT=0s"), "email.timeout"},
		{"bad from", []string{"APILENS_EMAIL__PROVIDER=smtp", "APILENS_EMAIL__HOST=h", "APILENS_EMAIL__FROM=not an address"}, "email.from"},
		{"bad reply_to", with("APILENS_EMAIL__REPLY_TO=nope"), "email.reply_to"},
		{"password without username", with("APILENS_EMAIL__PASSWORD=x"), "email.password"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load("", append([]string{kekEnv}, tc.env...), nil)
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tc.want != "" && err == nil:
				t.Fatalf("expected error containing %q", tc.want)
			case tc.want != "" && !strings.Contains(err.Error(), tc.want):
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}
