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
