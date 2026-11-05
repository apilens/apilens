// Package config loads and validates the binary's configuration.
//
// Precedence (lowest to highest): built-in defaults, an optional YAML file,
// APILENS_* environment variables, command-line flags. Nested keys use a
// double underscore in env vars: APILENS_POSTGRES__MAX_CONNS -> postgres.max_conns.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/confmap"
	"github.com/knadh/koanf/providers/env/v2"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
	"golang.org/x/net/publicsuffix"
)

// EnvPrefix is the prefix for environment overrides.
const EnvPrefix = "APILENS_"

// Config is the full runtime configuration.
type Config struct {
	Target     []string         `koanf:"target"`
	Server     ServerConfig     `koanf:"server"`
	Log        LogConfig        `koanf:"log"`
	Postgres   PostgresConfig   `koanf:"postgres"`
	ClickHouse ClickHouseConfig `koanf:"clickhouse"`
	Valkey     ValkeyConfig     `koanf:"valkey"`
	Ingest     IngestConfig     `koanf:"ingest"`
	Sink       SinkConfig       `koanf:"sink"`
	OTel       OTelConfig       `koanf:"otel"`
	Identity   IdentityConfig   `koanf:"identity"`
	Jobs       JobsConfig       `koanf:"jobs"`
	Authz      AuthzConfig      `koanf:"authz"`
	Email      EmailConfig      `koanf:"email"`
	Exports    ExportsConfig    `koanf:"exports"`
}

// ServerConfig configures the shared HTTP server.
type ServerConfig struct {
	Addr              string        `koanf:"addr"`
	AdminAddr         string        `koanf:"admin_addr"` // pprof; empty disables
	ReadHeaderTimeout time.Duration `koanf:"read_header_timeout"`
	ReadTimeout       time.Duration `koanf:"read_timeout"`
	WriteTimeout      time.Duration `koanf:"write_timeout"`
	IdleTimeout       time.Duration `koanf:"idle_timeout"`
	ShutdownTimeout   time.Duration `koanf:"shutdown_timeout"`
}

// LogConfig configures slog.
type LogConfig struct {
	Level  string `koanf:"level"`  // debug|info|warn|error
	Format string `koanf:"format"` // json|text
}

// PostgresConfig configures the pgx pool.
type PostgresConfig struct {
	URL      string `koanf:"url"`
	MaxConns int32  `koanf:"max_conns"`
}

// ClickHouseConfig configures the native-protocol ClickHouse client.
type ClickHouseConfig struct {
	Addr         []string      `koanf:"addr"`
	Database     string        `koanf:"database"`
	Username     string        `koanf:"username"`
	Password     string        `koanf:"password"`
	Secure       bool          `koanf:"secure"`
	MaxOpenConns int           `koanf:"max_open_conns"`
	DialTimeout  time.Duration `koanf:"dial_timeout"`
	// Cluster enables ON CLUSTER DDL for replicated deployments. Empty means
	// single node.
	Cluster string `koanf:"cluster"`
}

// ValkeyConfig configures the Valkey client. An empty Addr disables Valkey;
// caches then fall back to TTL-only invalidation.
type ValkeyConfig struct {
	Addr     []string `koanf:"addr"`
	Username string   `koanf:"username"`
	Password string   `koanf:"password"`
}

// Enabled reports whether a Valkey address is configured.
func (v ValkeyConfig) Enabled() bool { return len(v.Addr) > 0 }

// IngestConfig configures the edge role.
type IngestConfig struct {
	MaxBodyBytes         int64         `koanf:"max_body_bytes"`
	MaxRecordsPerRequest int           `koanf:"max_records_per_request"`
	KeyCacheSize         int           `koanf:"key_cache_size"`
	KeyCacheTTL          time.Duration `koanf:"key_cache_ttl"`
	KeyNegativeTTL       time.Duration `koanf:"key_negative_ttl"`
	AppCacheTTL          time.Duration `koanf:"app_cache_ttl"`
	Quota                QuotaConfig   `koanf:"quota"`
}

// QuotaConfig caps how much one project may ingest. Each limit is a token
// bucket in Valkey shared by every edge replica; zero disables it. Requests
// over a limit get 429 with Retry-After.
type QuotaConfig struct {
	// RecordsPerMinute bounds records (requests, logs, spans, deploys) per
	// project per minute. It must admit one full batch, so when set it is
	// at least ingest.max_records_per_request.
	RecordsPerMinute int64 `koanf:"records_per_minute"`
	// BytesPerDay bounds decompressed body bytes per project per day. When
	// set it is at least ingest.max_body_bytes.
	BytesPerDay int64 `koanf:"bytes_per_day"`
}

// Enabled reports whether any quota is set.
func (q QuotaConfig) Enabled() bool { return q.RecordsPerMinute > 0 || q.BytesPerDay > 0 }

// SinkConfig configures how ingested rows reach ClickHouse.
type SinkConfig struct {
	Mode          string        `koanf:"mode"` // direct (kafka arrives in M3)
	Ack           string        `koanf:"ack"`  // flush: reply after the batch is stored; enqueue: reply once buffered
	BatchSize     int           `koanf:"batch_size"`
	FlushInterval time.Duration `koanf:"flush_interval"`
	QueueSize     int           `koanf:"queue_size"`
	InsertTimeout time.Duration `koanf:"insert_timeout"`
	MaxRetries    int           `koanf:"max_retries"`
}

// OTelConfig configures APILens's own tracing. An empty Endpoint disables it.
type OTelConfig struct {
	Endpoint    string  `koanf:"endpoint"`
	Insecure    bool    `koanf:"insecure"`
	ServiceName string  `koanf:"service_name"`
	SampleRatio float64 `koanf:"sample_ratio"`
}

// ExportsConfig configures where request log exports (CSV, gzip) are kept
// until they expire. Dir is a local directory, the store of a single-VM
// install; empty means apilens-exports under the OS temp directory. The
// query role both writes and serves the files, so every query process must
// see the same directory.
type ExportsConfig struct {
	Dir string `koanf:"dir"`
}

// JobsConfig configures the River background-job client. Roles that run
// workers (identity in M2, worker later) start the worker loop only when
// Enabled; otherwise the client can still enqueue jobs.
type JobsConfig struct {
	Enabled bool `koanf:"enabled"`
	// MaxWorkers bounds concurrently running jobs on the default queue.
	MaxWorkers int `koanf:"max_workers"`
	// MetricsInterval is how often queue depth is sampled for /metrics.
	MetricsInterval time.Duration `koanf:"metrics_interval"`
}

// KeyEncryptionKeySize is the required length of identity.key_encryption_key
// once base64-decoded (AES-256).
const KeyEncryptionKeySize = 32

// IdentityConfig configures the identity role: token issuance, sessions,
// email codes and WebAuthn.
type IdentityConfig struct {
	// Issuer is the `iss` of issued tokens and the base of the JWKS URL.
	Issuer string `koanf:"issuer"`
	// PublicUIURL is the origin users open the dashboard at; used for links
	// in emails and OAuth redirects.
	PublicUIURL string `koanf:"public_ui_url"`
	// CookieDomain scopes session cookies. Empty means host-only.
	CookieDomain    string        `koanf:"cookie_domain"`
	AccessTokenTTL  time.Duration `koanf:"access_token_ttl"`
	RefreshTokenTTL time.Duration `koanf:"refresh_token_ttl"`
	// RefreshTokenTTLShort applies when "remember me" is off.
	RefreshTokenTTLShort time.Duration `koanf:"refresh_token_ttl_short"`
	EmailCodeTTL         time.Duration `koanf:"email_code_ttl"`
	EmailCodeMaxAttempts int           `koanf:"email_code_max_attempts"`
	// PreAuthTTL bounds the window between the first factor and MFA.
	PreAuthTTL time.Duration `koanf:"pre_auth_ttl"`
	// RecoveryDelay is the cooling-off period between requesting account
	// recovery (2FA device lost) and being allowed to confirm it.
	RecoveryDelay time.Duration `koanf:"recovery_delay"`
	// KeyEncryptionKey is 32 bytes, base64-encoded. It encrypts signing keys
	// and TOTP secrets at rest. Required when the identity role runs.
	KeyEncryptionKey string           `koanf:"key_encryption_key"`
	WebAuthn         WebAuthnConfig   `koanf:"webauthn"`
	RateLimits       RateLimitsConfig `koanf:"rate_limits"`
	// CORSOrigins are browser origins allowed to call /api/v1/auth/*
	// cross-origin. Empty (the default) disables CORS: the UI calls identity
	// server-side, and browsers reach it only through top-level navigations.
	CORSOrigins []string `koanf:"cors_origins"`
	// OAuth configures the optional social sign-in providers.
	OAuth OAuthConfig `koanf:"oauth"`
	// OIDCProvider configures APILens as an OpenID Connect provider and
	// OAuth 2.0 authorization server for MCP clients, agents and service
	// accounts (ADR 0005).
	OIDCProvider OIDCProviderConfig `koanf:"oidc_provider"`
}

// OIDCProviderConfig configures the built-in OpenID Connect provider.
type OIDCProviderConfig struct {
	// Enabled mounts /.well-known/openid-configuration and /oauth/* on the
	// identity role. Off by default.
	Enabled bool `koanf:"enabled"`
}

// OAuth provider names, as they appear in config keys and callback paths.
const (
	OAuthProviderGoogle = "google"
	OAuthProviderGitHub = "github"
)

// OAuthCallbackPath is the identity path an OAuth provider redirects back
// to, relative to identity.issuer. Format it with the provider name.
const OAuthCallbackPath = "/api/v1/auth/oauth/%s/callback"

// OAuthConfig configures the social sign-in providers. A provider is enabled
// when its client ID is set; each is independent.
type OAuthConfig struct {
	Google OAuthProviderConfig `koanf:"google"`
	GitHub OAuthProviderConfig `koanf:"github"`
}

// OAuthProviderConfig holds one OAuth app's credentials.
type OAuthProviderConfig struct {
	ClientID     string `koanf:"client_id"`
	ClientSecret string `koanf:"client_secret"`
}

// Enabled reports whether the provider is configured.
func (p OAuthProviderConfig) Enabled() bool { return p.ClientID != "" }

// OAuthRedirectURI returns the callback URL to register in provider's OAuth
// app: identity.issuer + /api/v1/auth/oauth/{provider}/callback.
func (i IdentityConfig) OAuthRedirectURI(provider string) string {
	return strings.TrimRight(i.Issuer, "/") + fmt.Sprintf(OAuthCallbackPath, provider)
}

// RateLimitsConfig configures the shared (Valkey) rate limits on the auth
// endpoints. Each limit is a sliding window.
type RateLimitsConfig struct {
	// TrustedProxies lists the IPs or CIDRs of reverse proxies whose
	// X-Forwarded-For entries are believed. Empty means the client IP is the
	// TCP peer and X-Forwarded-For is ignored.
	TrustedProxies      []string  `koanf:"trusted_proxies"`
	EmailStartPerEmail  RateLimit `koanf:"email_start_per_email"`
	EmailStartPerIP     RateLimit `koanf:"email_start_per_ip"`
	CodeVerifyPerEmail  RateLimit `koanf:"code_verify_per_email"`
	RefreshPerIP        RateLimit `koanf:"refresh_per_ip"`
	SecondFactorPerUser RateLimit `koanf:"second_factor_per_user"` // passkey and 2FA verify
	OAuthStartPerIP     RateLimit `koanf:"oauth_start_per_ip"`
	HandoffPerIP        RateLimit `koanf:"handoff_per_ip"` // one-time handoff code redemptions
	SSOLookupPerIP      RateLimit `koanf:"sso_lookup_per_ip"`
	PasskeyLoginPerIP   RateLimit `koanf:"passkey_login_per_ip"` // passkey sign-in options and verify, each
	SlugCheckPerUser    RateLimit `koanf:"slug_check_per_user"`  // slug availability checks
	// RecoveryRequestPerEmail limits account recovery requests per address.
	RecoveryRequestPerEmail RateLimit `koanf:"recovery_request_per_email"`
	// RecoveryPerIP limits each recovery endpoint (request, status,
	// confirm, cancel) per client IP.
	RecoveryPerIP RateLimit `koanf:"recovery_per_ip"`
	// InvitationLookupPerIP limits public invitation link lookups
	// (GET /api/v1/auth/invitations/{token}) per client IP.
	InvitationLookupPerIP RateLimit `koanf:"invitation_lookup_per_ip"`
}

// RateLimit allows Limit requests per sliding Window.
type RateLimit struct {
	Limit  int           `koanf:"limit"`
	Window time.Duration `koanf:"window"`
}

// WebAuthnConfig configures the WebAuthn relying party.
type WebAuthnConfig struct {
	RPID    string   `koanf:"rp_id"`
	RPName  string   `koanf:"rp_name"`
	Origins []string `koanf:"origins"`
}

// Validate checks that rp_id is a valid RP ID for every origin: a domain
// (no scheme, port, path or IP address) that equals each origin's host or is
// a registrable domain suffix of it. Browsers refuse a ceremony otherwise.
// Origins that are not absolute http(s) URLs are reported by the caller.
func (w WebAuthnConfig) Validate() []error {
	rpID := w.RPID
	if rpID == "" || rpID != strings.ToLower(rpID) || strings.ContainsAny(rpID, ":/?#@[] ") ||
		strings.HasPrefix(rpID, ".") || strings.HasSuffix(rpID, ".") || net.ParseIP(rpID) != nil {
		return []error{fmt.Errorf("identity.webauthn.rp_id %q: want a lowercase domain name (no scheme, port or path), e.g. example.com", rpID)}
	}
	var errs []error
	for _, o := range w.Origins {
		u, err := url.Parse(o)
		if err != nil || u.Hostname() == "" {
			continue
		}
		if !rpIDValidForHost(rpID, strings.ToLower(u.Hostname())) {
			errs = append(errs, fmt.Errorf("identity.webauthn.rp_id %q is not a registrable domain suffix of origin %q", rpID, o))
		}
	}
	return errs
}

// rpIDValidForHost reports whether rpID equals host or is a registrable domain
// suffix of it (HTML "is a registrable domain suffix of or is equal to"): host
// is a subdomain of rpID and rpID is not itself a public suffix such as co.uk.
func rpIDValidForHost(rpID, host string) bool {
	if host == rpID {
		return true
	}
	if net.ParseIP(host) != nil || !strings.HasSuffix(host, "."+rpID) {
		return false
	}
	suffix, _ := publicsuffix.PublicSuffix(rpID)
	return suffix != rpID
}

// AuthzConfig configures the SpiceDB client (ADR 0006). An empty Endpoint
// disables authorization: `apilens migrate` then skips the schema.
type AuthzConfig struct {
	// Endpoint is the SpiceDB gRPC address (host:port), e.g. spicedb:50051.
	Endpoint string `koanf:"endpoint"`
	// PresharedKey authenticates APILens to SpiceDB (its
	// --grpc-preshared-key). Required when Endpoint is set.
	PresharedKey string `koanf:"preshared_key"`
	// Insecure dials without TLS. Use it only on a private network (the
	// compose stack, an in-cluster Service).
	Insecure bool `koanf:"insecure"`
	// CacheTTL bounds how long a permission check result may be reused.
	// 0 disables the client-side cache.
	CacheTTL time.Duration `koanf:"cache_ttl"`
}

// Enabled reports whether a SpiceDB endpoint is configured.
func (a AuthzConfig) Enabled() bool { return a.Endpoint != "" }

// KEK returns the decoded key encryption key.
func (i IdentityConfig) KEK() ([]byte, error) {
	if i.KeyEncryptionKey == "" {
		return nil, errors.New("identity.key_encryption_key is not set (generate one with: openssl rand -base64 32)")
	}
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(i.KeyEncryptionKey))
	if err != nil {
		return nil, fmt.Errorf("identity.key_encryption_key is not valid base64 (generate one with: openssl rand -base64 32): %w", err)
	}
	if len(b) != KeyEncryptionKeySize {
		return nil, fmt.Errorf("identity.key_encryption_key decodes to %d bytes, want %d (generate one with: openssl rand -base64 32)", len(b), KeyEncryptionKeySize)
	}
	return b, nil
}

// IdentityEnabled reports whether the identity role runs in this process
// (targets "identity" or "all").
func (c *Config) IdentityEnabled() bool {
	return slices.Contains(c.Target, "identity") || slices.Contains(c.Target, "all")
}

// Email providers.
const (
	// EmailProviderSMTP delivers mail through an SMTP relay.
	EmailProviderSMTP = "smtp"
	// EmailProviderLog writes the rendered message to the logger instead of
	// sending it. It needs no network and is the default.
	EmailProviderLog = "log"
)

// Email transport security modes.
const (
	// EmailTLSStartTLS upgrades a plain connection with STARTTLS (port 587).
	EmailTLSStartTLS = "starttls"
	// EmailTLSImplicit connects over TLS from the start (port 465).
	EmailTLSImplicit = "tls"
	// EmailTLSNone sends in plain text. Only for local relays.
	EmailTLSNone = "none"
)

// EmailConfig configures transactional email (sign-in codes, invitations,
// security alerts).
type EmailConfig struct {
	// Provider is smtp or log. log (the default) prints messages to the
	// logger and delivers nothing.
	Provider string `koanf:"provider"`
	Host     string `koanf:"host"`
	Port     int    `koanf:"port"`
	Username string `koanf:"username"`
	Password string `koanf:"password"`
	// From is the sender address, e.g. `APILens <no-reply@example.com>`.
	// Required for smtp.
	From    string `koanf:"from"`
	ReplyTo string `koanf:"reply_to"`
	// TLS is starttls, tls (implicit) or none.
	TLS     string        `koanf:"tls"`
	Timeout time.Duration `koanf:"timeout"`
}

// LogOnly reports whether email is written to the log instead of delivered.
func (e EmailConfig) LogOnly() bool { return e.Provider == EmailProviderLog }

// Defaults returns the built-in configuration. These are suitable for the
// docker-compose all-in-one deployment.
func Defaults() map[string]any {
	return map[string]any{
		"target":                           []string{"all"},
		"server.addr":                      ":8080",
		"server.admin_addr":                "",
		"server.read_header_timeout":       "5s",
		"server.read_timeout":              "30s",
		"server.write_timeout":             "30s",
		"server.idle_timeout":              "120s",
		"server.shutdown_timeout":          "30s",
		"log.level":                        "info",
		"log.format":                       "json",
		"postgres.url":                     "postgres://apilens@localhost:5432/apilens?sslmode=disable",
		"postgres.max_conns":               20,
		"clickhouse.addr":                  []string{"localhost:9000"},
		"clickhouse.database":              "apilens",
		"clickhouse.username":              "apilens",
		"clickhouse.password":              "",
		"clickhouse.secure":                false,
		"clickhouse.max_open_conns":        16,
		"clickhouse.dial_timeout":          "5s",
		"clickhouse.cluster":               "",
		"valkey.addr":                      []string{},
		"ingest.max_body_bytes":            int64(16 << 20),
		"ingest.max_records_per_request":   1000,
		"ingest.key_cache_size":            100_000,
		"ingest.key_cache_ttl":             "60s",
		"ingest.key_negative_ttl":          "10s",
		"ingest.app_cache_ttl":             "60s",
		"ingest.quota.records_per_minute":  0,
		"ingest.quota.bytes_per_day":       0,
		"sink.mode":                        "direct",
		"sink.ack":                         "flush",
		"sink.batch_size":                  10_000,
		"sink.flush_interval":              "250ms",
		"sink.queue_size":                  1024,
		"sink.insert_timeout":              "10s",
		"sink.max_retries":                 3,
		"otel.endpoint":                    "",
		"otel.insecure":                    false,
		"otel.service_name":                "apilens",
		"otel.sample_ratio":                0.05,
		"identity.issuer":                  "http://localhost:8080",
		"identity.public_ui_url":           "http://localhost:3000",
		"identity.cookie_domain":           "",
		"identity.access_token_ttl":        "15m",
		"identity.refresh_token_ttl":       "720h",
		"identity.refresh_token_ttl_short": "24h",
		"identity.email_code_ttl":          "15m",
		"identity.email_code_max_attempts": 5,
		"identity.pre_auth_ttl":            "5m",
		"identity.recovery_delay":          "24h",
		"identity.key_encryption_key":      "",
		"identity.webauthn.rp_id":          "localhost",
		"identity.webauthn.rp_name":        "APILens",
		"identity.webauthn.origins":        []string{"http://localhost:3000"},
		"identity.cors_origins":            []string{},
		"identity.oidc_provider.enabled":   false,
		"jobs.enabled":                     true,
		"jobs.max_workers":                 10,
		"jobs.metrics_interval":            "15s",
		"exports.dir":                      "",

		"identity.oauth.google.client_id":     "",
		"identity.oauth.google.client_secret": "",
		"identity.oauth.github.client_id":     "",
		"identity.oauth.github.client_secret": "",

		"identity.rate_limits.trusted_proxies":                   []string{},
		"identity.rate_limits.email_start_per_email.limit":       5,
		"identity.rate_limits.email_start_per_email.window":      "15m",
		"identity.rate_limits.email_start_per_ip.limit":          20,
		"identity.rate_limits.email_start_per_ip.window":         "15m",
		"identity.rate_limits.code_verify_per_email.limit":       10,
		"identity.rate_limits.code_verify_per_email.window":      "15m",
		"identity.rate_limits.refresh_per_ip.limit":              60,
		"identity.rate_limits.refresh_per_ip.window":             "1m",
		"identity.rate_limits.second_factor_per_user.limit":      10,
		"identity.rate_limits.second_factor_per_user.window":     "15m",
		"identity.rate_limits.oauth_start_per_ip.limit":          30,
		"identity.rate_limits.oauth_start_per_ip.window":         "15m",
		"identity.rate_limits.handoff_per_ip.limit":              30,
		"identity.rate_limits.handoff_per_ip.window":             "15m",
		"identity.rate_limits.sso_lookup_per_ip.limit":           60,
		"identity.rate_limits.sso_lookup_per_ip.window":          "15m",
		"identity.rate_limits.invitation_lookup_per_ip.limit":    60,
		"identity.rate_limits.invitation_lookup_per_ip.window":   "15m",
		"identity.rate_limits.passkey_login_per_ip.limit":        60,
		"identity.rate_limits.passkey_login_per_ip.window":       "15m",
		"identity.rate_limits.slug_check_per_user.limit":         60,
		"identity.rate_limits.slug_check_per_user.window":        "1m",
		"identity.rate_limits.recovery_request_per_email.limit":  3,
		"identity.rate_limits.recovery_request_per_email.window": "1h",
		"identity.rate_limits.recovery_per_ip.limit":             20,
		"identity.rate_limits.recovery_per_ip.window":            "15m",
		"authz.endpoint":      "",
		"authz.preshared_key": "",
		"authz.insecure":      false,
		"authz.cache_ttl":     "5s",
		"email.provider":      EmailProviderLog,
		"email.host":          "",
		"email.port":          587,
		"email.username":      "",
		"email.password":      "",
		"email.from":          "",
		"email.reply_to":      "",
		"email.tls":           EmailTLSStartTLS,
		"email.timeout":       "10s",
	}
}

// Load builds the configuration from defaults, an optional YAML file, the
// environment and explicit flag overrides (already-parsed key/value pairs).
func Load(filePath string, environ []string, overrides map[string]any) (*Config, error) {
	k := koanf.New(".")
	if err := k.Load(confmap.Provider(Defaults(), "."), nil); err != nil {
		return nil, err
	}
	if filePath != "" {
		if err := k.Load(file.Provider(filePath), yaml.Parser()); err != nil {
			return nil, fmt.Errorf("config: read %s: %w", filePath, err)
		}
	}
	envProvider := env.Provider(".", env.Opt{
		Prefix: EnvPrefix,
		TransformFunc: func(key, value string) (string, any) {
			key = strings.ToLower(strings.TrimPrefix(key, EnvPrefix))
			key = strings.ReplaceAll(key, "__", ".")
			// Comma-separated values for list-typed keys.
			if isListKey(key) {
				return key, splitList(value)
			}
			return key, value
		},
		EnvironFunc: func() []string { return environ },
	})
	if err := k.Load(envProvider, nil); err != nil {
		return nil, fmt.Errorf("config: env: %w", err)
	}
	if len(overrides) > 0 {
		if err := k.Load(confmap.Provider(overrides, "."), nil); err != nil {
			return nil, err
		}
	}

	var cfg Config
	if err := k.UnmarshalWithConf("", &cfg, koanf.UnmarshalConf{Tag: "koanf"}); err != nil {
		return nil, fmt.Errorf("config: decode: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// identifierRE bounds names that end up in DDL (CREATE DATABASE).
var identifierRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

var listKeys = map[string]bool{
	"target": true, "clickhouse.addr": true, "valkey.addr": true, "identity.webauthn.origins": true,
	"identity.cors_origins":                true,
	"identity.rate_limits.trusted_proxies": true,
}

func isListKey(key string) bool { return listKeys[key] }

func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Validate checks invariants that would otherwise fail late at runtime.
func (c *Config) Validate() error {
	var errs []error
	if len(c.Target) == 0 {
		errs = append(errs, errors.New("target must not be empty"))
	}
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, fmt.Errorf("log.level %q: want debug|info|warn|error", c.Log.Level))
	}
	switch c.Log.Format {
	case "json", "text":
	default:
		errs = append(errs, fmt.Errorf("log.format %q: want json|text", c.Log.Format))
	}
	if c.Server.Addr == "" {
		errs = append(errs, errors.New("server.addr must not be empty"))
	}
	if c.Postgres.URL == "" {
		errs = append(errs, errors.New("postgres.url must not be empty"))
	}
	if c.Postgres.MaxConns <= 0 {
		errs = append(errs, errors.New("postgres.max_conns must be > 0"))
	}
	if len(c.ClickHouse.Addr) == 0 {
		errs = append(errs, errors.New("clickhouse.addr must not be empty"))
	}
	if c.ClickHouse.Cluster != "" {
		errs = append(errs, errors.New("clickhouse.cluster is not supported yet (replicated topology arrives in M3); leave it empty"))
	}
	if !identifierRE.MatchString(c.ClickHouse.Database) {
		errs = append(errs, fmt.Errorf("clickhouse.database %q: want letters, digits and underscores", c.ClickHouse.Database))
	}
	if c.Ingest.MaxBodyBytes <= 0 || c.Ingest.MaxRecordsPerRequest <= 0 {
		errs = append(errs, errors.New("ingest.max_body_bytes and ingest.max_records_per_request must be > 0"))
	}
	if c.Ingest.KeyCacheSize <= 0 {
		errs = append(errs, errors.New("ingest.key_cache_size must be > 0"))
	}
	errs = append(errs, c.validateQuota()...)
	switch c.Sink.Mode {
	case "direct":
	case "kafka":
		errs = append(errs, errors.New("sink.mode=kafka is not available yet (planned for M3)"))
	default:
		errs = append(errs, fmt.Errorf("sink.mode %q: want direct", c.Sink.Mode))
	}
	switch c.Sink.Ack {
	case "flush", "enqueue":
	default:
		errs = append(errs, fmt.Errorf("sink.ack %q: want flush|enqueue", c.Sink.Ack))
	}
	if c.Sink.BatchSize <= 0 || c.Sink.QueueSize <= 0 || c.Sink.FlushInterval <= 0 {
		errs = append(errs, errors.New("sink.batch_size, sink.queue_size and sink.flush_interval must be > 0"))
	}
	if c.OTel.SampleRatio < 0 || c.OTel.SampleRatio > 1 {
		errs = append(errs, errors.New("otel.sample_ratio must be within [0,1]"))
	}
	if c.Jobs.MaxWorkers <= 0 || c.Jobs.MaxWorkers > 10_000 {
		errs = append(errs, errors.New("jobs.max_workers must be within [1,10000]"))
	}
	if c.Jobs.MetricsInterval <= 0 {
		errs = append(errs, errors.New("jobs.metrics_interval must be > 0"))
	}
	errs = append(errs, c.validateIdentity()...)
	errs = append(errs, c.validateAuthz()...)
	errs = append(errs, c.validateEmail()...)
	if len(errs) > 0 {
		return fmt.Errorf("config: %w", errors.Join(errs...))
	}
	return nil
}

// validateIdentity checks the identity section. The key encryption key is
// required only when the identity role runs, but is checked whenever set.
func (c *Config) validateIdentity() []error {
	var errs []error
	id := c.Identity
	if c.IdentityEnabled() || id.KeyEncryptionKey != "" {
		if _, err := id.KEK(); err != nil {
			if c.IdentityEnabled() && id.KeyEncryptionKey == "" {
				err = fmt.Errorf("%w; it is required when target includes identity (set APILENS_IDENTITY__KEY_ENCRYPTION_KEY)", err)
			}
			errs = append(errs, err)
		}
	}
	if !isHTTPURL(id.Issuer) {
		errs = append(errs, fmt.Errorf("identity.issuer %q: want an absolute http(s) URL", id.Issuer))
	}
	if !isHTTPURL(id.PublicUIURL) {
		errs = append(errs, fmt.Errorf("identity.public_ui_url %q: want an absolute http(s) URL", id.PublicUIURL))
	}
	for _, o := range id.WebAuthn.Origins {
		if !isHTTPURL(o) {
			errs = append(errs, fmt.Errorf("identity.webauthn.origins %q: want an absolute http(s) URL", o))
		}
	}
	if len(id.WebAuthn.Origins) == 0 {
		errs = append(errs, errors.New("identity.webauthn.origins must not be empty"))
	}
	for _, o := range id.CORSOrigins {
		if !isOrigin(o) {
			errs = append(errs, fmt.Errorf("identity.cors_origins %q: want an http(s) origin (scheme://host[:port], no path)", o))
		}
	}
	if id.WebAuthn.RPID == "" || id.WebAuthn.RPName == "" {
		errs = append(errs, errors.New("identity.webauthn.rp_id and identity.webauthn.rp_name must not be empty"))
	} else {
		errs = append(errs, id.WebAuthn.Validate()...)
	}
	if id.AccessTokenTTL <= 0 || id.RefreshTokenTTL <= 0 || id.RefreshTokenTTLShort <= 0 ||
		id.EmailCodeTTL <= 0 || id.PreAuthTTL <= 0 || id.RecoveryDelay <= 0 {
		errs = append(errs, errors.New("identity.access_token_ttl, refresh_token_ttl, refresh_token_ttl_short, email_code_ttl, pre_auth_ttl and recovery_delay must be > 0"))
	}
	if id.RefreshTokenTTLShort > id.RefreshTokenTTL {
		errs = append(errs, errors.New("identity.refresh_token_ttl_short must not exceed identity.refresh_token_ttl"))
	}
	if id.EmailCodeMaxAttempts <= 0 {
		errs = append(errs, errors.New("identity.email_code_max_attempts must be > 0"))
	}
	errs = append(errs, id.OAuth.validate()...)
	return append(errs, id.RateLimits.validate()...)
}

// validate requires a client secret for every provider with a client ID, and
// rejects a secret without an ID (almost certainly a misspelt key).
func (o OAuthConfig) validate() []error {
	var errs []error
	for _, p := range []struct {
		name string
		cfg  OAuthProviderConfig
	}{
		{OAuthProviderGoogle, o.Google},
		{OAuthProviderGitHub, o.GitHub},
	} {
		env := "APILENS_IDENTITY__OAUTH__" + strings.ToUpper(p.name)
		switch {
		case p.cfg.ClientID != "" && p.cfg.ClientSecret == "":
			errs = append(errs, fmt.Errorf("identity.oauth.%s.client_secret is required when client_id is set (set %s__CLIENT_SECRET)", p.name, env))
		case p.cfg.ClientID == "" && p.cfg.ClientSecret != "":
			errs = append(errs, fmt.Errorf("identity.oauth.%s.client_id is required when client_secret is set (set %s__CLIENT_ID)", p.name, env))
		}
	}
	return errs
}

func (r RateLimitsConfig) validate() []error {
	var errs []error
	for _, p := range r.TrustedProxies {
		if _, err := netip.ParsePrefix(p); err == nil {
			continue
		}
		if _, err := netip.ParseAddr(p); err != nil {
			errs = append(errs, fmt.Errorf("identity.rate_limits.trusted_proxies %q: want an IP or CIDR", p))
		}
	}
	limits := []struct {
		name string
		l    RateLimit
	}{
		{"email_start_per_email", r.EmailStartPerEmail},
		{"email_start_per_ip", r.EmailStartPerIP},
		{"code_verify_per_email", r.CodeVerifyPerEmail},
		{"refresh_per_ip", r.RefreshPerIP},
		{"second_factor_per_user", r.SecondFactorPerUser},
		{"oauth_start_per_ip", r.OAuthStartPerIP},
		{"handoff_per_ip", r.HandoffPerIP},
		{"sso_lookup_per_ip", r.SSOLookupPerIP},
		{"invitation_lookup_per_ip", r.InvitationLookupPerIP},
		{"passkey_login_per_ip", r.PasskeyLoginPerIP},
		{"slug_check_per_user", r.SlugCheckPerUser},
		{"recovery_request_per_email", r.RecoveryRequestPerEmail},
		{"recovery_per_ip", r.RecoveryPerIP},
	}
	for _, l := range limits {
		if l.l.Limit <= 0 || l.l.Window < time.Second {
			errs = append(errs, fmt.Errorf("identity.rate_limits.%s: want limit > 0 and window >= 1s (got %d per %v)", l.name, l.l.Limit, l.l.Window))
		}
	}
	return errs
}

// validateAuthz checks the authz section when SpiceDB is configured.
func (c *Config) validateAuthz() []error {
	var errs []error
	a := c.Authz
	if a.CacheTTL < 0 {
		errs = append(errs, errors.New("authz.cache_ttl must be >= 0"))
	}
	if !a.Enabled() {
		return errs
	}
	if _, port, err := net.SplitHostPort(a.Endpoint); err != nil || port == "" {
		errs = append(errs, fmt.Errorf("authz.endpoint %q: want host:port", a.Endpoint))
	}
	if a.PresharedKey == "" {
		errs = append(errs, errors.New("authz.preshared_key is required when authz.endpoint is set (set APILENS_AUTHZ__PRESHARED_KEY)"))
	}
	return errs
}

// validateEmail checks the email section. Addresses are checked whenever
// set; host and from are required only for smtp.
func (c *Config) validateEmail() []error {
	var errs []error
	e := c.Email
	switch e.Provider {
	case EmailProviderSMTP, EmailProviderLog:
	default:
		errs = append(errs, fmt.Errorf("email.provider %q: want smtp|log", e.Provider))
	}
	switch e.TLS {
	case EmailTLSStartTLS, EmailTLSImplicit, EmailTLSNone:
	default:
		errs = append(errs, fmt.Errorf("email.tls %q: want starttls|tls|none", e.TLS))
	}
	if e.Timeout <= 0 {
		errs = append(errs, errors.New("email.timeout must be > 0"))
	}
	if e.Port <= 0 || e.Port > 65535 {
		errs = append(errs, fmt.Errorf("email.port %d: want 1-65535", e.Port))
	}
	if e.From != "" {
		if _, err := mail.ParseAddress(e.From); err != nil {
			errs = append(errs, fmt.Errorf("email.from %q: not a valid address: %w", e.From, err))
		}
	}
	if e.ReplyTo != "" {
		if _, err := mail.ParseAddress(e.ReplyTo); err != nil {
			errs = append(errs, fmt.Errorf("email.reply_to %q: not a valid address: %w", e.ReplyTo, err))
		}
	}
	if e.Password != "" && e.Username == "" {
		errs = append(errs, errors.New("email.password is set without email.username"))
	}
	if e.Provider == EmailProviderSMTP {
		if e.From == "" {
			errs = append(errs, errors.New("email.from is required when email.provider is smtp (set APILENS_EMAIL__FROM)"))
		}
		if e.Host == "" {
			errs = append(errs, errors.New("email.host is required when email.provider is smtp (set APILENS_EMAIL__HOST)"))
		}
	}
	return errs
}

func isHTTPURL(v string) bool {
	u, err := url.Parse(v)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// isOrigin reports whether v is a bare http(s) origin, as browsers send it in
// the Origin header: no path, query, fragment or user info.
func isOrigin(v string) bool {
	u, err := url.Parse(v)
	return err == nil && isHTTPURL(v) && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && !u.ForceQuery
}

// validateQuota checks ingest.quota: limits are non-negative, admit at least
// one maximal request, and need Valkey to share their buckets.
func (c *Config) validateQuota() []error {
	q := c.Ingest.Quota
	var errs []error
	if q.RecordsPerMinute < 0 || q.BytesPerDay < 0 {
		errs = append(errs, errors.New("ingest.quota.records_per_minute and ingest.quota.bytes_per_day must be >= 0 (0 disables)"))
	}
	if q.RecordsPerMinute > 0 && q.RecordsPerMinute < int64(c.Ingest.MaxRecordsPerRequest) {
		errs = append(errs, fmt.Errorf("ingest.quota.records_per_minute must be 0 or >= ingest.max_records_per_request (%d)", c.Ingest.MaxRecordsPerRequest))
	}
	if q.BytesPerDay > 0 && q.BytesPerDay < c.Ingest.MaxBodyBytes {
		errs = append(errs, fmt.Errorf("ingest.quota.bytes_per_day must be 0 or >= ingest.max_body_bytes (%d)", c.Ingest.MaxBodyBytes))
	}
	if q.Enabled() && !c.Valkey.Enabled() {
		errs = append(errs, errors.New("ingest.quota needs valkey.addr: quota buckets are shared through Valkey"))
	}
	return errs
}
