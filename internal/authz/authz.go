// Package authz is the one way APILens asks SpiceDB for permissions
// (ADR 0006). Every consumer goes through Client so the fail-closed rule
// lives in one place: a check that cannot be answered is a denial.
//
// Freshness: after a relationship write the returned ZedToken is stored per
// organization (TokenStore, Valkey in production), and reads about that
// organization ask SpiceDB for at_least_as_fresh that token, so a role change
// is visible to the next request on any replica. Reads with no stored token
// use minimize_latency; when the token store is unreachable they fall back to
// fully_consistent, which is slower but never stale.
//
// Allowed results are cached for Options.CacheTTL keyed by (subject,
// permission, resource, zedtoken): a newer write changes the token and so
// misses the cache. Denials are never cached.
package authz

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/hashicorp/golang-lru/v2/expirable"
	"github.com/prometheus/client_golang/prometheus"
)

// ErrUnavailable means SpiceDB is not configured or could not answer. The
// accompanying result is always a denial; callers should answer 503 rather
// than 403 when they see it.
var ErrUnavailable = errors.New("authz: spicedb unavailable")

// Object types defined in authz/schema.zed.
const (
	TypeUser         = "user"
	TypeOrganization = "organization"
	TypeProject      = "project"
)

// Permission is a permission (or relation) name from authz/schema.zed.
type Permission string

// Permissions defined in authz/schema.zed; see authz/README.md for the
// mapping from UI actions.
const (
	// organization
	OrgManage        Permission = "manage"
	OrgManageMembers Permission = "manage_members"
	OrgInvite        Permission = "invite"
	OrgManageBilling Permission = "manage_billing"
	OrgCreateProject Permission = "create_project"
	OrgView          Permission = "view"

	// project
	ProjectDelete        Permission = "delete"
	ProjectManageKeys    Permission = "manage_keys"
	ProjectManageCapture Permission = "manage_capture"
	ProjectEdit          Permission = "edit"
	ProjectView          Permission = "view"
)

// Object identifies a SpiceDB object.
type Object struct {
	Type string
	ID   string
}

// User is the subject for a signed-in user.
func User(id string) Object { return Object{Type: TypeUser, ID: id} }

func (o Object) String() string { return o.Type + ":" + o.ID }

func (o Object) ref() *v1.ObjectReference {
	return &v1.ObjectReference{ObjectType: o.Type, ObjectId: o.ID}
}

func (o Object) subject() *v1.SubjectReference {
	return &v1.SubjectReference{Object: o.ref()}
}

// Resource is an object together with the organization it belongs to. Org
// selects which stored ZedToken bounds the read's freshness.
type Resource struct {
	Object
	Org string
}

// Organization is the resource for an organization.
func Organization(id string) Resource {
	return Resource{Object: Object{Type: TypeOrganization, ID: id}, Org: id}
}

// Project is the resource for a project in organization orgID.
func Project(orgID, id string) Resource {
	return Resource{Object: Object{Type: TypeProject, ID: id}, Org: orgID}
}

// CheckItem is one question in a CheckBulk call.
type CheckItem struct {
	Subject    Object
	Permission Permission
	Resource   Resource
}

// Options tunes a Client.
type Options struct {
	// CacheTTL bounds how long an allowed result is reused (config
	// authz.cache_ttl). 0 disables the cache.
	CacheTTL time.Duration
	// CacheSize caps the number of cached results. Default 10000.
	CacheSize int
	// Timeout bounds each SpiceDB call. Default 2s.
	Timeout time.Duration
}

// Client checks permissions against SpiceDB. It is safe for concurrent use.
type Client struct {
	perms   v1.PermissionsServiceClient // nil: authz not configured, every check denies
	tokens  TokenStore
	logger  *slog.Logger
	cache   *expirable.LRU[cacheKey, struct{}] // nil when disabled
	timeout time.Duration
	m       metrics
}

type cacheKey struct {
	subject, permission, resource, token string
}

type metrics struct {
	checks   *prometheus.CounterVec
	errors   *prometheus.CounterVec
	hits     prometheus.Counter
	duration *prometheus.HistogramVec
}

// New returns a Client. perms is usually the *authzed.Client from
// spicedb.Connect; nil makes every check deny with ErrUnavailable. tokens may
// be nil (no read-after-write freshness). logger and reg may be nil.
func New(perms v1.PermissionsServiceClient, tokens TokenStore, opts Options, logger *slog.Logger, reg prometheus.Registerer) *Client {
	if opts.CacheSize <= 0 {
		opts.CacheSize = 10_000
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 2 * time.Second
	}
	if tokens == nil {
		tokens = noTokens{}
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	c := &Client{
		perms:   perms,
		tokens:  tokens,
		logger:  logger,
		timeout: opts.Timeout,
		m: metrics{
			checks: prometheus.NewCounterVec(prometheus.CounterOpts{
				Name: "apilens_authz_checks_total", Help: "Permission checks by outcome (allowed, denied, error).",
			}, []string{"op", "result"}),
			errors: prometheus.NewCounterVec(prometheus.CounterOpts{
				Name: "apilens_authz_errors_total", Help: "SpiceDB calls that failed; the affected checks were denied (fail closed).",
			}, []string{"op"}),
			hits: prometheus.NewCounter(prometheus.CounterOpts{
				Name: "apilens_authz_cache_hits_total", Help: "Permission checks answered from the local cache.",
			}),
			duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
				Name: "apilens_authz_request_duration_seconds", Help: "SpiceDB call latency.",
				Buckets: []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5},
			}, []string{"op"}),
		},
	}
	if opts.CacheTTL > 0 {
		c.cache = expirable.NewLRU[cacheKey, struct{}](opts.CacheSize, nil, opts.CacheTTL)
	}
	if reg != nil {
		reg.MustRegister(c.m.checks, c.m.errors, c.m.hits, c.m.duration)
	}
	return c
}

// Check reports whether subject has permission on resource. Any failure to
// get an answer from SpiceDB returns false with an error wrapping
// ErrUnavailable.
func (c *Client) Check(ctx context.Context, subject Object, permission Permission, resource Resource) (bool, error) {
	const op = "check"
	if c.perms == nil {
		return c.fail(op, 1, ErrUnavailable)
	}
	consistency, token := c.consistency(ctx, resource.Org)
	key := cacheKey{subject.String(), string(permission), resource.String(), token}
	if c.cached(key) {
		c.m.checks.WithLabelValues(op, "allowed").Inc()
		return true, nil
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	start := time.Now()
	resp, err := c.perms.CheckPermission(ctx, &v1.CheckPermissionRequest{
		Consistency: consistency,
		Resource:    resource.ref(),
		Permission:  string(permission),
		Subject:     subject.subject(),
	})
	c.m.duration.WithLabelValues(op).Observe(time.Since(start).Seconds())
	if err != nil {
		c.logger.Warn("authz check failed; denying", "subject", subject, "permission", permission, "resource", resource.Object, "error", err)
		return c.fail(op, 1, fmt.Errorf("%w: %w", ErrUnavailable, err))
	}
	allowed := resp.GetPermissionship() == v1.CheckPermissionResponse_PERMISSIONSHIP_HAS_PERMISSION
	c.record(op, key, allowed)
	return allowed, nil
}

// CheckBulk answers every item in one SpiceDB round trip; results[i] answers
// items[i]. When the call fails every result is false and err wraps
// ErrUnavailable. An item SpiceDB could not evaluate is false and is
// reported through err (the other results stay valid).
func (c *Client) CheckBulk(ctx context.Context, items []CheckItem) ([]bool, error) {
	const op = "check_bulk"
	results := make([]bool, len(items))
	if len(items) == 0 {
		return results, nil
	}
	if c.perms == nil {
		_, err := c.fail(op, len(items), ErrUnavailable)
		return results, err
	}

	consistency, tokens := c.bulkConsistency(ctx, items)
	keys := make([]cacheKey, len(items))
	var pending []int // indexes of items not answered from cache
	for i, it := range items {
		keys[i] = cacheKey{it.Subject.String(), string(it.Permission), it.Resource.String(), tokens[it.Resource.Org]}
		if c.cached(keys[i]) {
			results[i] = true
			c.m.checks.WithLabelValues(op, "allowed").Inc()
			continue
		}
		pending = append(pending, i)
	}
	if len(pending) == 0 {
		return results, nil
	}

	req := &v1.CheckBulkPermissionsRequest{Consistency: consistency, Items: make([]*v1.CheckBulkPermissionsRequestItem, len(pending))}
	for j, i := range pending {
		req.Items[j] = &v1.CheckBulkPermissionsRequestItem{
			Resource:   items[i].Resource.ref(),
			Permission: string(items[i].Permission),
			Subject:    items[i].Subject.subject(),
		}
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	start := time.Now()
	resp, err := c.perms.CheckBulkPermissions(ctx, req)
	c.m.duration.WithLabelValues(op).Observe(time.Since(start).Seconds())
	if err == nil && len(resp.GetPairs()) != len(pending) {
		err = fmt.Errorf("got %d results for %d items", len(resp.GetPairs()), len(pending))
	}
	if err != nil {
		c.logger.Warn("authz bulk check failed; denying", "items", len(pending), "error", err)
		_, err = c.fail(op, len(pending), fmt.Errorf("%w: %w", ErrUnavailable, err))
		return make([]bool, len(items)), err
	}

	var itemErrs []error
	for j, pair := range resp.GetPairs() {
		i := pending[j]
		if e := pair.GetError(); e != nil {
			c.m.errors.WithLabelValues(op).Inc()
			c.m.checks.WithLabelValues(op, "error").Inc()
			itemErrs = append(itemErrs, fmt.Errorf("item %d (%s#%s): %s", i, items[i].Resource.Object, items[i].Permission, e.GetMessage()))
			continue
		}
		allowed := pair.GetItem().GetPermissionship() == v1.CheckPermissionResponse_PERMISSIONSHIP_HAS_PERMISSION
		results[i] = allowed
		c.record(op, keys[i], allowed)
	}
	if len(itemErrs) > 0 {
		return results, fmt.Errorf("%w: %w", ErrUnavailable, errors.Join(itemErrs...))
	}
	return results, nil
}

// LookupResources returns the IDs of every resourceType object on which
// subject has permission, e.g. the projects a user can view. org bounds
// freshness by that organization's last write; "" reads fully consistent.
// On failure it returns nil and an error wrapping ErrUnavailable, never a
// partial list.
func (c *Client) LookupResources(ctx context.Context, org string, subject Object, permission Permission, resourceType string) ([]string, error) {
	const op = "lookup_resources"
	if c.perms == nil {
		c.m.errors.WithLabelValues(op).Inc()
		return nil, ErrUnavailable
	}
	consistency := fullyConsistent()
	if org != "" {
		consistency, _ = c.consistency(ctx, org)
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	start := time.Now()
	ids, err := c.lookup(ctx, &v1.LookupResourcesRequest{
		Consistency:        consistency,
		ResourceObjectType: resourceType,
		Permission:         string(permission),
		Subject:            subject.subject(),
	})
	c.m.duration.WithLabelValues(op).Observe(time.Since(start).Seconds())
	if err != nil {
		c.m.errors.WithLabelValues(op).Inc()
		c.logger.Warn("authz lookup failed; returning nothing", "subject", subject, "permission", permission, "type", resourceType, "error", err)
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return ids, nil
}

func (c *Client) lookup(ctx context.Context, req *v1.LookupResourcesRequest) ([]string, error) {
	stream, err := c.perms.LookupResources(ctx, req)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for {
		resp, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return ids, nil
		}
		if err != nil {
			return nil, err
		}
		// Caveated (conditional) results are not grants: no caveat context
		// is ever supplied, so treat them as denied.
		if resp.GetPermissionship() == v1.LookupPermissionship_LOOKUP_PERMISSIONSHIP_HAS_PERMISSION {
			ids = append(ids, resp.GetResourceObjectId())
		}
	}
}

// WriteRelationships applies updates and records the returned ZedToken for
// org, so later reads about org see the write. The token is recorded on a
// best-effort basis: if the token store fails the write still stands and the
// error is only logged.
func (c *Client) WriteRelationships(ctx context.Context, org string, updates []*v1.RelationshipUpdate) (string, error) {
	const op = "write"
	if c.perms == nil {
		c.m.errors.WithLabelValues(op).Inc()
		return "", ErrUnavailable
	}
	wctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	start := time.Now()
	resp, err := c.perms.WriteRelationships(wctx, &v1.WriteRelationshipsRequest{Updates: updates})
	c.m.duration.WithLabelValues(op).Observe(time.Since(start).Seconds())
	if err != nil {
		c.m.errors.WithLabelValues(op).Inc()
		return "", fmt.Errorf("authz: write relationships: %w", err)
	}
	token := resp.GetWrittenAt().GetToken()
	if err := c.RecordToken(ctx, org, token); err != nil {
		c.logger.Warn("authz: could not record zedtoken; reads may briefly be stale", "org", org, "error", err)
	}
	return token, nil
}

// RecordToken stores token as the latest write for org. Callers that write
// to SpiceDB some other way use it to keep reads fresh.
func (c *Client) RecordToken(ctx context.Context, org, token string) error {
	if org == "" || token == "" {
		return nil
	}
	return c.tokens.Set(ctx, org, token)
}

// uncachedToken stands in for the token when the token store failed: the
// read is fully consistent and its result is neither served from nor stored
// in the cache. Real ZedTokens are base64 and never start with "!".
const uncachedToken = "!uncached"

// consistency picks the read consistency for org and returns the token it
// used ("" when none).
func (c *Client) consistency(ctx context.Context, org string) (*v1.Consistency, string) {
	if org == "" {
		return minimizeLatency(), ""
	}
	token, err := c.tokens.Get(ctx, org)
	if err != nil {
		c.logger.Warn("authz: zedtoken store unavailable; reading fully consistent", "org", org, "error", err)
		return fullyConsistent(), uncachedToken
	}
	if token == "" {
		return minimizeLatency(), ""
	}
	return &v1.Consistency{Requirement: &v1.Consistency_AtLeastAsFresh{AtLeastAsFresh: &v1.ZedToken{Token: token}}}, token
}

// bulkConsistency picks one consistency for a bulk call. ZedTokens are
// opaque and cannot be compared, so items spanning orgs with different
// tokens are read fully consistent.
func (c *Client) bulkConsistency(ctx context.Context, items []CheckItem) (*v1.Consistency, map[string]string) {
	tokens := map[string]string{}
	var chosen *v1.Consistency
	distinct := map[string]bool{}
	for _, it := range items {
		org := it.Resource.Org
		if _, seen := tokens[org]; seen {
			continue
		}
		cons, token := c.consistency(ctx, org)
		tokens[org] = token
		if token == "" {
			continue
		}
		distinct[token] = true
		chosen = cons
	}
	switch {
	case len(distinct) == 0:
		return minimizeLatency(), tokens
	case len(distinct) == 1:
		return chosen, tokens
	default:
		return fullyConsistent(), tokens
	}
}

func fullyConsistent() *v1.Consistency {
	return &v1.Consistency{Requirement: &v1.Consistency_FullyConsistent{FullyConsistent: true}}
}

func minimizeLatency() *v1.Consistency {
	return &v1.Consistency{Requirement: &v1.Consistency_MinimizeLatency{MinimizeLatency: true}}
}

func (c *Client) cached(key cacheKey) bool {
	if c.cache == nil || key.token == uncachedToken {
		return false
	}
	if _, ok := c.cache.Get(key); ok {
		c.m.hits.Inc()
		return true
	}
	return false
}

// record counts an answered check and caches it when allowed.
func (c *Client) record(op string, key cacheKey, allowed bool) {
	if !allowed {
		c.m.checks.WithLabelValues(op, "denied").Inc()
		return
	}
	c.m.checks.WithLabelValues(op, "allowed").Inc()
	if c.cache != nil && key.token != uncachedToken {
		c.cache.Add(key, struct{}{})
	}
}

// fail counts n failed checks and returns a denial.
func (c *Client) fail(op string, n int, err error) (bool, error) {
	c.m.errors.WithLabelValues(op).Inc()
	c.m.checks.WithLabelValues(op, "error").Add(float64(n))
	return false, err
}
