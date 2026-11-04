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
}

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
	// KeyEncryptionKey is 32 bytes, base64-encoded. It encrypts signing keys
	// and TOTP secrets at rest. Required when the identity role runs.
	KeyEncryptionKey string         `koanf:"key_encryption_key"`
	WebAuthn         WebAuthnConfig `koanf:"webauthn"`
}

// WebAuthnConfig configures the WebAuthn relying party.
type WebAuthnConfig struct {
	RPID    string   `koanf:"rp_id"`
	RPName  string   `koanf:"rp_name"`
	Origins []string `koanf:"origins"`
}

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
		"identity.key_encryption_key":      "",
		"identity.webauthn.rp_id":          "localhost",
		"identity.webauthn.rp_name":        "APILens",
		"identity.webauthn.origins":        []string{"http://localhost:3000"},
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
	errs = append(errs, c.validateIdentity()...)
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
	if id.WebAuthn.RPID == "" || id.WebAuthn.RPName == "" {
		errs = append(errs, errors.New("identity.webauthn.rp_id and identity.webauthn.rp_name must not be empty"))
	}
	if id.AccessTokenTTL <= 0 || id.RefreshTokenTTL <= 0 || id.RefreshTokenTTLShort <= 0 ||
		id.EmailCodeTTL <= 0 || id.PreAuthTTL <= 0 {
		errs = append(errs, errors.New("identity.access_token_ttl, refresh_token_ttl, refresh_token_ttl_short, email_code_ttl and pre_auth_ttl must be > 0"))
	}
	if id.RefreshTokenTTLShort > id.RefreshTokenTTL {
		errs = append(errs, errors.New("identity.refresh_token_ttl_short must not exceed identity.refresh_token_ttl"))
	}
	if id.EmailCodeMaxAttempts <= 0 {
		errs = append(errs, errors.New("identity.email_code_max_attempts must be > 0"))
	}
	return errs
}

func isHTTPURL(v string) bool {
	u, err := url.Parse(v)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}
