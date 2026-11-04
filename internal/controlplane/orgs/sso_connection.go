package orgs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/identity/audit"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
)

// SSOSecretMask is what a read of an SSO connection shows in place of its
// client secret. Saving the mask back keeps the stored secret.
const SSOSecretMask = "********"

// Bounds of the SSO connection settings.
const (
	MaxSSOIssuerLen       = 2048
	MaxSSOClientIDLen     = 255
	MaxSSOClientSecretLen = 1024
)

// ssoDiscoveryTimeout bounds a test of an issuer's OIDC discovery.
const ssoDiscoveryTimeout = 10 * time.Second

// maxDiscoveryDocument bounds the discovery document read by a test.
const maxDiscoveryDocument = 1 << 20

// Errors returned by SSOConnections.
var (
	// ErrSSONotConfigured: the organization has no SSO connection.
	ErrSSONotConfigured = errors.New("orgs: sso not configured")
	// ErrSSOUntested: turning enforcement on needs the caller to have
	// signed in through the organization's connection at least once.
	ErrSSOUntested = errors.New("orgs: sso untested")
	// ErrSSOSecretRequired: a new connection needs a client secret.
	ErrSSOSecretRequired = errors.New("orgs: sso client secret required")
	// ErrSSOUnavailable: the identity key-encryption key is not configured
	// in this process, so client secrets cannot be sealed.
	ErrSSOUnavailable = errors.New("orgs: sso secrets unavailable")
)

// SSODomainTakenError is returned when an enforcing connection lists a
// domain another organization already enforces SSO for.
type SSODomainTakenError struct {
	Domains []string
}

func (e *SSODomainTakenError) Error() string {
	return "orgs: sso domain enforced by another organization: " + strings.Join(e.Domains, ", ")
}

// SSOConnection is an organization's OIDC connection without its secret.
type SSOConnection struct {
	OrgID       uuid.UUID
	Slug        string
	Issuer      string
	ClientID    string
	Domains     []string
	Enforce     bool
	DefaultRole string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	LastLoginAt *time.Time
}

// SSOSettings replace an organization's OIDC connection. A nil ClientSecret
// (or SSOSecretMask) keeps the stored one; a new connection needs one.
type SSOSettings struct {
	Issuer       string
	ClientID     string
	ClientSecret *string
	Domains      []string
	Enforce      bool
	DefaultRole  string
}

// SSOTestResult is the outcome of an OIDC discovery test. When OK is false,
// Error says why (one of the SSOTest* values) and the metadata is empty.
type SSOTestResult struct {
	OK     bool
	Issuer string
	Error  string
	// HTTPStatus is the discovery response status (SSOTestBadStatus only).
	HTTPStatus int

	AuthorizationEndpoint string
	TokenEndpoint         string
	UserinfoEndpoint      string
	JWKSURI               string
	ScopesSupported       []string
	ResponseTypes         []string
	SigningAlgs           []string
}

// Failures of an SSO connection test.
const (
	SSOTestUnreachable      = "unreachable"
	SSOTestBadStatus        = "bad_status"
	SSOTestInvalidDocument  = "invalid_document"
	SSOTestIssuerMismatch   = "issuer_mismatch"
	SSOTestMissingEndpoints = "missing_endpoints"
)

// SSOConnections manages organizations' single sign-on connections
// (org_sso_connections). Every operation is for owners only.
type SSOConnections struct {
	pool   *pgxpool.Pool
	audit  Auditor
	sealer *idkeys.Sealer
	client *http.Client
}

// NewSSOConnections returns the service over pool. sealer (the identity
// key-encryption key) seals client secrets; nil makes saves fail with
// ErrSSOUnavailable.
func NewSSOConnections(pool *pgxpool.Pool, auditor Auditor, sealer *idkeys.Sealer) *SSOConnections {
	return &SSOConnections{
		pool:   pool,
		audit:  auditor,
		sealer: sealer,
		client: &http.Client{
			Timeout: ssoDiscoveryTimeout,
			// A discovery document is served at a fixed URL; following
			// redirects would only widen where a test can reach.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// ValidSSOIssuer reports whether issuer is an OIDC issuer URL a connection
// may use: an absolute https URL without query, fragment or credentials, or
// http on a loopback host (local development).
func ValidSSOIssuer(issuer string) bool {
	if issuer == "" || len(issuer) > MaxSSOIssuerLen || strings.TrimSpace(issuer) != issuer {
		return false
	}
	u, err := url.Parse(issuer)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		return isLoopback(u.Hostname())
	default:
		return false
	}
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ownerOrg returns the active organization slug for user, who must be an
// owner of it.
func ownerOrg(ctx context.Context, q *db.Queries, user uuid.UUID, slug string, lock bool) (uuid.UUID, string, error) {
	var (
		id   uuid.UUID
		role string
		s    string
	)
	if lock {
		r, err := lockMember(ctx, q, user, slug)
		if err != nil {
			return uuid.Nil, "", err
		}
		id, role, s = r.ID, r.Role, r.Slug
	} else {
		r, err := q.GetMemberOrganization(ctx, db.GetMemberOrganizationParams{UserID: user, Slug: slug})
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, "", ErrNotFound
		}
		if err != nil {
			return uuid.Nil, "", fmt.Errorf("orgs: get organization: %w", err)
		}
		id, role, s = r.ID, r.Role, r.Slug
	}
	if role != RoleOwner {
		return uuid.Nil, "", ErrForbidden
	}
	return id, s, nil
}

func toSSOConnection(c db.OrgSsoConnection, slug string) SSOConnection {
	domains := c.Domains
	if domains == nil {
		domains = []string{}
	}
	return SSOConnection{
		OrgID: c.OrgID, Slug: slug, Issuer: c.Issuer, ClientID: c.ClientID, Domains: domains,
		Enforce: c.Enforce, DefaultRole: c.DefaultRole,
		CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt, LastLoginAt: c.LastLoginAt,
	}
}

// Get returns the SSO connection of organization slug for user, an owner.
func (s *SSOConnections) Get(ctx context.Context, user uuid.UUID, slug string) (SSOConnection, error) {
	q := db.New(s.pool)
	org, orgSlug, err := ownerOrg(ctx, q, user, slug, false)
	if err != nil {
		return SSOConnection{}, err
	}
	c, err := q.GetOrgSSOConnection(ctx, org)
	if errors.Is(err, pgx.ErrNoRows) {
		return SSOConnection{}, ErrSSONotConfigured
	}
	if err != nil {
		return SSOConnection{}, fmt.Errorf("orgs: get sso connection: %w", err)
	}
	return toSSOConnection(c, orgSlug), nil
}

// validateSSO checks set and returns its domains deduplicated.
func validateSSO(set SSOSettings) ([]string, error) {
	if !ValidSSOIssuer(set.Issuer) {
		return nil, ErrInvalid
	}
	if set.ClientID == "" || len(set.ClientID) > MaxSSOClientIDLen || strings.TrimSpace(set.ClientID) != set.ClientID {
		return nil, ErrInvalid
	}
	if set.ClientSecret != nil && (*set.ClientSecret == "" || len(*set.ClientSecret) > MaxSSOClientSecretLen) {
		return nil, ErrInvalid
	}
	if !ValidRole(set.DefaultRole) || set.DefaultRole == RoleOwner {
		return nil, ErrInvalid
	}
	domains := make([]string, 0, len(set.Domains))
	for _, d := range set.Domains {
		if !ValidDomain(d) {
			return nil, ErrInvalid
		}
		if identity.IsPublicEmailDomain(d) {
			return nil, &DomainNotAllowedError{Domain: d}
		}
		if !slices.Contains(domains, d) {
			domains = append(domains, d)
		}
	}
	if len(domains) == 0 || len(domains) > MaxAllowedDomains {
		return nil, ErrInvalid
	}
	return domains, nil
}

// Put creates or replaces the SSO connection of organization slug on behalf
// of user, an owner. Turning enforcement on needs user to have signed in
// through the connection since it was created (ErrSSOUntested), and none of
// its domains may be enforced by another organization
// (*SSODomainTakenError). The change is audited as sso.updated.
func (s *SSOConnections) Put(ctx context.Context, user uuid.UUID, slug string, set SSOSettings) (SSOConnection, bool, error) {
	domains, err := validateSSO(set)
	if err != nil {
		return SSOConnection{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SSOConnection{}, false, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	org, orgSlug, err := ownerOrg(ctx, q, user, slug, true)
	if err != nil {
		return SSOConnection{}, false, err
	}
	cur, err := q.GetOrgSSOConnection(ctx, org)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return SSOConnection{}, false, fmt.Errorf("orgs: get sso connection: %w", err)
	}

	secret := cur.ClientSecretEnc
	secretChanged := set.ClientSecret != nil && *set.ClientSecret != SSOSecretMask
	if secretChanged || !exists {
		if !secretChanged {
			return SSOConnection{}, false, ErrSSOSecretRequired
		}
		if s.sealer == nil {
			return SSOConnection{}, false, ErrSSOUnavailable
		}
		if secret, err = identity.SealSSOClientSecret(s.sealer, org, *set.ClientSecret); err != nil {
			return SSOConnection{}, false, err
		}
	}

	if set.Enforce {
		if err := q.LockSSOEnforcement(ctx); err != nil {
			return SSOConnection{}, false, fmt.Errorf("orgs: lock sso enforcement: %w", err)
		}
		taken, err := q.EnforcedSSODomainsOfOtherOrgs(ctx, db.EnforcedSSODomainsOfOtherOrgsParams{OrgID: org, Domains: domains})
		if err != nil {
			return SSOConnection{}, false, fmt.Errorf("orgs: check sso domains: %w", err)
		}
		if len(taken) > 0 {
			return SSOConnection{}, false, &SSODomainTakenError{Domains: taken}
		}
		if !exists || !cur.Enforce {
			// Turning enforcement on: the owner must have proved the
			// connection works for them, or they could lock everyone out.
			if !exists {
				return SSOConnection{}, false, ErrSSOUntested
			}
			ok, err := q.HasSSOSignInSince(ctx, db.HasSSOSignInSinceParams{UserID: &user, OrgID: org.String(), Since: cur.CreatedAt})
			if err != nil {
				return SSOConnection{}, false, fmt.Errorf("orgs: check sso sign-in: %w", err)
			}
			if !ok {
				return SSOConnection{}, false, ErrSSOUntested
			}
		}
	}

	c, err := q.UpsertOrgSSOConnection(ctx, db.UpsertOrgSSOConnectionParams{
		OrgID: org, Issuer: set.Issuer, ClientID: set.ClientID, ClientSecretEnc: secret,
		Domains: domains, Enforce: set.Enforce, DefaultRole: set.DefaultRole,
	})
	if err != nil {
		return SSOConnection{}, false, fmt.Errorf("orgs: save sso connection: %w", err)
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.SSOUpdated,
		Meta: map[string]any{
			"org_id":         org.String(),
			"slug":           orgSlug,
			"created":        !exists,
			"enforce":        set.Enforce,
			"secret_changed": secretChanged,
			"fields":         ssoChanged(cur, exists, c, secretChanged),
		},
	}); err != nil {
		return SSOConnection{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SSOConnection{}, false, fmt.Errorf("orgs: commit: %w", err)
	}
	return toSSOConnection(c, orgSlug), !exists, nil
}

// ssoChanged lists the settings that differ between before and after, for
// the audit event. Every field counts as changed on a new connection.
func ssoChanged(before db.OrgSsoConnection, existed bool, after db.OrgSsoConnection, secretChanged bool) []string {
	out := []string{}
	add := func(name string, changed bool) {
		if !existed || changed {
			out = append(out, name)
		}
	}
	add("issuer", before.Issuer != after.Issuer)
	add("client_id", before.ClientID != after.ClientID)
	add("client_secret", secretChanged)
	add("domains", !slices.Equal(before.Domains, after.Domains))
	add("enforce", before.Enforce != after.Enforce)
	add("default_role", before.DefaultRole != after.DefaultRole)
	return out
}

// Delete removes the SSO connection of organization slug on behalf of user,
// an owner. Audited as sso.deleted.
func (s *SSOConnections) Delete(ctx context.Context, user uuid.UUID, slug string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	org, orgSlug, err := ownerOrg(ctx, q, user, slug, true)
	if err != nil {
		return err
	}
	n, err := q.DeleteOrgSSOConnection(ctx, org)
	if err != nil {
		return fmt.Errorf("orgs: delete sso connection: %w", err)
	}
	if n == 0 {
		return ErrSSONotConfigured
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.SSODeleted,
		Meta:  map[string]any{"org_id": org.String(), "slug": orgSlug},
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("orgs: commit: %w", err)
	}
	return nil
}

// Test runs OIDC discovery on issuer, or on the saved connection's issuer
// when issuer is empty, on behalf of user, an owner of organization slug,
// and reports the provider's metadata. A provider that cannot be reached or
// serves an unusable document is a result with OK false, not an error.
func (s *SSOConnections) Test(ctx context.Context, user uuid.UUID, slug, issuer string) (SSOTestResult, error) {
	q := db.New(s.pool)
	org, _, err := ownerOrg(ctx, q, user, slug, false)
	if err != nil {
		return SSOTestResult{}, err
	}
	if issuer == "" {
		c, err := q.GetOrgSSOConnection(ctx, org)
		if errors.Is(err, pgx.ErrNoRows) {
			return SSOTestResult{}, ErrSSONotConfigured
		}
		if err != nil {
			return SSOTestResult{}, fmt.Errorf("orgs: get sso connection: %w", err)
		}
		issuer = c.Issuer
	}
	if !ValidSSOIssuer(issuer) {
		return SSOTestResult{}, ErrInvalid
	}
	return s.discover(ctx, issuer), nil
}

// discoveryDocument is the part of an OpenID Provider Configuration
// (OpenID Connect Discovery 1.0 §3) a test reports.
type discoveryDocument struct {
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	UserinfoEndpoint      string   `json:"userinfo_endpoint"`
	JWKSURI               string   `json:"jwks_uri"`
	ScopesSupported       []string `json:"scopes_supported"`
	ResponseTypes         []string `json:"response_types_supported"`
	SigningAlgs           []string `json:"id_token_signing_alg_values_supported"`
}

// discover fetches and checks issuer's discovery document the way the SSO
// sign-in does (go-oidc): the document's issuer must equal issuer exactly.
func (s *SSOConnections) discover(ctx context.Context, issuer string) SSOTestResult {
	res := SSOTestResult{Issuer: issuer}
	ctx, cancel := context.WithTimeout(ctx, ssoDiscoveryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(issuer, "/")+"/.well-known/openid-configuration", nil)
	if err != nil {
		res.Error = SSOTestUnreachable
		return res
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		res.Error = SSOTestUnreachable
		return res
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		res.Error, res.HTTPStatus = SSOTestBadStatus, resp.StatusCode
		return res
	}
	var doc discoveryDocument
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxDiscoveryDocument)).Decode(&doc); err != nil {
		res.Error = SSOTestInvalidDocument
		return res
	}
	if doc.Issuer != issuer {
		res.Error = SSOTestIssuerMismatch
		return res
	}
	if doc.AuthorizationEndpoint == "" || doc.TokenEndpoint == "" || doc.JWKSURI == "" {
		res.Error = SSOTestMissingEndpoints
		return res
	}
	res.OK = true
	res.AuthorizationEndpoint = doc.AuthorizationEndpoint
	res.TokenEndpoint = doc.TokenEndpoint
	res.UserinfoEndpoint = doc.UserinfoEndpoint
	res.JWKSURI = doc.JWKSURI
	res.ScopesSupported = nonNil(doc.ScopesSupported)
	res.ResponseTypes = nonNil(doc.ResponseTypes)
	res.SigningAlgs = nonNil(doc.SigningAlgs)
	return res
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
