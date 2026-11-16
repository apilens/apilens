package apikeys

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// Key scopes.
const (
	// ScopeIngest lets a key send telemetry to the edge.
	ScopeIngest = "ingest"
	// ScopeRead lets a key read the project's data through the query API.
	ScopeRead = "read"
	// ScopeAppsCreate lets ingest create an app from an app name the key's
	// data carries that the project does not have yet. It needs ingest and
	// has no effect on a key limited to some apps.
	ScopeAppsCreate = "apps:create"
)

// Scopes are the scopes a key can carry, in storage order.
var Scopes = []string{ScopeIngest, ScopeAppsCreate, ScopeRead}

// MaxKeyApps bounds the apps a key can be limited to.
const MaxKeyApps = 100

// MaxKeyEnvironments bounds the environments a key can be pinned to.
const MaxKeyEnvironments = 50

// MaxNameLen bounds a key's display name.
const MaxNameLen = 100

// MaxRateLimitPerMinute bounds a key's ingest rate limit.
const MaxRateLimitPerMinute = 100_000_000

// Errors returned by Service.
var (
	// ErrInvalid: the name, scopes or expiry are unusable.
	ErrInvalid = errors.New("apikeys: invalid name, scopes or expiry")
	// ErrNotFound: no active project has the id (it was deleted after the
	// caller authorized the request).
	ErrNotFound = errors.New("apikeys: project not found")
	// ErrKeyNotFound: the project has no key with the id.
	ErrKeyNotFound = errors.New("apikeys: key not found")
	// ErrKeyLimit: the project already has ingest.max_keys_per_project
	// active keys.
	ErrKeyLimit = errors.New("apikeys: key limit reached")
	// ErrKeyNotActive: the key is revoked, expired or already rotated, so it
	// cannot be rotated.
	ErrKeyNotActive = errors.New("apikeys: key not active")
)

// Key is an API key as listed to project members. The raw key is never
// stored, so it is not part of Key.
type Key struct {
	ID         uuid.UUID
	ProjectID  uuid.UUID
	Name       string
	Prefix     string
	Scopes     []string
	AppIDs     []uuid.UUID // nil: every app
	CreatedAt  time.Time
	ExpiresAt  *time.Time
	RevokedAt  *time.Time
	LastUsedAt *time.Time
	// Environments are the environment names the key may send data for;
	// nil: every environment.
	Environments []string
	// LastUsedSDK is the SDK name and version of the last ingest request.
	LastUsedSDK *string
	// LastUsedIP is the client IP of the last ingest request (only while
	// ingest.record_key_ip is true).
	LastUsedIP *netip.Addr
	// CreatedBy is the user who created the key; nil when unknown or the
	// account is deleted.
	CreatedBy *Creator
	// RateLimitPerMinute caps the records ingest accepts with the key per
	// minute; nil: no per-key limit.
	RateLimitPerMinute *int
	// AppsSeen are the apps the key sent records for, most recent first
	// (List only).
	AppsSeen []KeyApp
	// RotatedFrom is the key this one replaced in a rotation; nil if none.
	RotatedFrom *uuid.UUID
	// RotatedTo is the key that replaced this one in a rotation; nil if
	// none.
	RotatedTo *uuid.UUID
}

// Creator is the user who created a key.
type Creator struct {
	ID   uuid.UUID
	Name string // the user's name, or their email when they have none
}

// creator builds the Creator of a key row; nil when the user is unknown or
// deleted (the query's LEFT JOIN found nothing).
func creator(id *uuid.UUID, name, email *string) *Creator {
	if id == nil {
		return nil
	}
	c := &Creator{ID: *id}
	if name != nil && strings.TrimSpace(*name) != "" {
		c.Name = *name
	} else if email != nil {
		c.Name = *email
	}
	return c
}

// CanCreateApps reports whether ingest creates apps from this key's data.
func (k Key) CanCreateApps() bool {
	return k.AppIDs == nil && slices.Contains(k.Scopes, ScopeAppsCreate)
}

// KeyApp is an app a key sent records for.
type KeyApp struct {
	AppID       uuid.UUID
	Slug        string
	Name        string
	FirstSeenAt time.Time
	LastSeenAt  time.Time
}

// NewKey describes a key to create.
type NewKey struct {
	Name      string
	Scopes    []string
	ExpiresAt *time.Time
	// CanCreateApps adds apps:create to an ingest key; nil means true.
	CanCreateApps *bool
	// AppIDs limits the key to these apps of the project; nil allows every
	// app. A limited key never creates apps.
	AppIDs []uuid.UUID
	// RateLimitPerMinute caps the records ingest accepts with the key per
	// minute (1..MaxRateLimitPerMinute); nil: no per-key limit.
	RateLimitPerMinute *int
	// Environments pins the key to these environments of the project; nil
	// allows every environment.
	Environments []string
}

// Access is what an existing key may do with apps and environments, and
// how fast.
type Access struct {
	CanCreateApps bool
	AppIDs        []uuid.UUID // nil: every app
	// RateLimitPerMinute replaces the key's ingest rate limit when set: a
	// positive value is the new limit, 0 removes it. nil keeps the current
	// one.
	RateLimitPerMinute *int
	// Environments replaces the key's environments (nil: every
	// environment) when SetEnvironments is true; otherwise they are kept.
	Environments    []string
	SetEnvironments bool
}

// Created is a newly created key with its raw value, which is shown once.
type Created struct {
	Key
	Raw string
}

// Auditor records audit events; *audit.Recorder satisfies it. Record must
// write in the transaction audit.WithTx puts in the context.
type Auditor interface {
	Record(ctx context.Context, e audit.Event) error
}

// Invalidator tells every verifier to forget a revoked key hash, usually by
// publishing it on InvalidateChannel.
type Invalidator func(ctx context.Context, hash string) error

// Service creates, lists and revokes the API keys of projects on behalf of
// signed-in users.
//
// The service does not authorize: callers check the SpiceDB permission first
// with the authz guard (view to list keys, manage_keys to create, change and
// revoke them) and pass the project id it resolved.
type Service struct {
	pool       *pgxpool.Pool
	audit      Auditor
	invalidate Invalidator
	logger     *slog.Logger
	now        func() time.Time
	// maxKeys caps the active keys of a project (ingest.max_keys_per_project);
	// 0: no cap.
	maxKeys int
}

// NewService returns a Service over pool. invalidate may be nil, in which
// case a revoked key stays usable until verifier caches expire it.
func NewService(pool *pgxpool.Pool, auditor Auditor, invalidate Invalidator, logger *slog.Logger) *Service {
	return &Service{pool: pool, audit: auditor, invalidate: invalidate, logger: logger, now: time.Now}
}

// WithMaxKeys caps the active (not revoked, not expired) keys of a project
// at n (ingest.max_keys_per_project); 0 removes the cap. It returns s.
func (s *Service) WithMaxKeys(n int) *Service {
	s.maxKeys = n
	return s
}

// checkKeyLimit returns ErrKeyLimit when the project already has the most
// active keys it may have. The caller holds the project row lock, so
// concurrent creates cannot both pass. Key rotation must call it too.
func (s *Service) checkKeyLimit(ctx context.Context, q *db.Queries, projectID uuid.UUID) error {
	if s.maxKeys <= 0 {
		return nil
	}
	n, err := q.CountActiveProjectAPIKeys(ctx, projectID)
	if err != nil {
		return fmt.Errorf("apikeys: count keys: %w", err)
	}
	if int(n) >= s.maxKeys {
		return ErrKeyLimit
	}
	return nil
}

// rateLimit converts a requested per-key rate limit for storage: nil stays
// nil (no limit), a value outside 1..MaxRateLimitPerMinute is ErrInvalid.
func rateLimit(v *int) (*int32, error) {
	if v == nil {
		return nil, nil
	}
	if *v < 1 || *v > MaxRateLimitPerMinute {
		return nil, ErrInvalid
	}
	n := int32(*v) // #nosec G115 -- bounded above
	return &n, nil
}

// intPtr widens a stored rate limit.
func intPtr(v *int32) *int {
	if v == nil {
		return nil
	}
	n := int(*v)
	return &n
}

// NormalizeScopes validates scopes and returns them deduplicated in the
// order of Scopes. At least one scope is required.
func NormalizeScopes(in []string) ([]string, error) {
	if len(in) == 0 {
		return nil, ErrInvalid
	}
	out := make([]string, 0, len(Scopes))
	for _, s := range in {
		if !slices.Contains(Scopes, s) {
			return nil, ErrInvalid
		}
	}
	for _, s := range Scopes {
		if slices.Contains(in, s) {
			out = append(out, s)
		}
	}
	if slices.Contains(out, ScopeAppsCreate) && !slices.Contains(out, ScopeIngest) {
		return nil, ErrInvalid
	}
	return out, nil
}

// withAppsCreate returns scopes with apps:create added or removed; it only
// applies to ingest keys.
func withAppsCreate(scopes []string, on bool) []string {
	out := make([]string, 0, len(Scopes))
	for _, s := range Scopes {
		switch {
		case s == ScopeAppsCreate:
			if on && slices.Contains(scopes, ScopeIngest) {
				out = append(out, s)
			}
		case slices.Contains(scopes, s):
			out = append(out, s)
		}
	}
	return out
}

// checkApps validates an app scope against the project's apps: every id
// must name an app of the project that is not deleted. nil is every app.
func checkApps(ctx context.Context, q *db.Queries, projectID uuid.UUID, ids []uuid.UUID, now time.Time) ([]uuid.UUID, error) {
	if ids == nil {
		return nil, nil
	}
	if len(ids) == 0 || len(ids) > MaxKeyApps {
		return nil, ErrInvalid
	}
	since := now
	rows, err := q.ListResolverApps(ctx, db.ListResolverAppsParams{ProjectID: projectID, DeletedSince: &since})
	if err != nil {
		return nil, fmt.Errorf("apikeys: list apps: %w", err)
	}
	known := map[uuid.UUID]bool{}
	for _, r := range rows {
		if r.DeletedAt == nil {
			known[r.ID] = true
		}
	}
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if !known[id] {
			return nil, ErrInvalid
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out, nil
}

// checkEnvironments validates an environment pin against the project's
// environments: every name must be an environment of the project. nil is
// every environment. Names are trimmed and deduplicated, in request order.
func checkEnvironments(ctx context.Context, q *db.Queries, projectID uuid.UUID, names []string) ([]string, error) {
	if names == nil {
		return nil, nil
	}
	if len(names) == 0 || len(names) > MaxKeyEnvironments {
		return nil, ErrInvalid
	}
	rows, err := q.ListProjectsEnvironments(ctx, []uuid.UUID{projectID})
	if err != nil {
		return nil, fmt.Errorf("apikeys: list environments: %w", err)
	}
	known := map[string]bool{}
	for _, r := range rows {
		known[r.Name] = true
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		n = strings.TrimSpace(n)
		if !known[n] {
			return nil, ErrInvalid
		}
		if !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	return out, nil
}

// Create issues a key named name with scopes for the project projectID on
// behalf of user. name is trimmed; expiresAt, when set, must be in the
// future. The raw key is returned once and only its hash is stored. Audited
// as api_key.created.
func (s *Service) Create(ctx context.Context, user, projectID uuid.UUID, name string, scopes []string, expiresAt *time.Time) (Created, error) {
	return s.CreateKey(ctx, user, projectID, NewKey{Name: name, Scopes: scopes, ExpiresAt: expiresAt})
}

// CreateKey is Create with app permissions: an ingest key may create apps
// unless k.CanCreateApps is false, and k.AppIDs limits it to some apps.
func (s *Service) CreateKey(ctx context.Context, user, projectID uuid.UUID, k NewKey) (Created, error) {
	name, expiresAt := strings.TrimSpace(k.Name), k.ExpiresAt
	if name == "" || len([]rune(name)) > MaxNameLen {
		return Created{}, ErrInvalid
	}
	scopes, err := NormalizeScopes(k.Scopes)
	if err != nil {
		return Created{}, err
	}
	scopes = withAppsCreate(scopes, k.CanCreateApps == nil || *k.CanCreateApps)
	if expiresAt != nil {
		if !expiresAt.After(s.now()) {
			return Created{}, ErrInvalid
		}
		t := expiresAt.UTC()
		expiresAt = &t
	}
	limit, err := rateLimit(k.RateLimitPerMinute)
	if err != nil {
		return Created{}, err
	}
	raw, prefix, hash, err := Generate()
	if err != nil {
		return Created{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Created{}, fmt.Errorf("apikeys: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, projectID)
	if err != nil {
		return Created{}, err
	}
	if err := s.checkKeyLimit(ctx, q, p.ID); err != nil {
		return Created{}, err
	}
	appIDs, err := checkApps(ctx, q, p.ID, k.AppIDs, s.now())
	if err != nil {
		return Created{}, err
	}
	envs, err := checkEnvironments(ctx, q, p.ID, k.Environments)
	if err != nil {
		return Created{}, err
	}
	row, err := q.CreateAPIKey(ctx, db.CreateAPIKeyParams{
		ID: uuid.New(), ProjectID: p.ID, Name: name, Prefix: prefix, KeyHash: hash, Scopes: scopes, ExpiresAt: expiresAt, AppIds: appIDs,
		CreatedBy: &user, RateLimitPerMinute: limit, Environments: envs,
	})
	if err != nil {
		return Created{}, fmt.Errorf("apikeys: create: %w", err)
	}
	meta := keyMeta(p, row.ID, row.Name, row.Prefix, row.Scopes)
	meta["app_ids"] = idStrings(row.AppIds)
	meta["rate_limit_per_minute"] = intPtr(row.RateLimitPerMinute)
	meta["environments"] = row.Environments
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:    &user,
		Actor:   &user,
		Kind:    audit.APIKeyCreated,
		Org:     &p.OrgID,
		Project: &p.ID,
		Target:  keyTarget(row.ID, row.Name),
		Changes: &audit.Changes{Next: map[string]any{
			"name": row.Name, "prefix": row.Prefix, "scopes": row.Scopes, "app_ids": idStrings(row.AppIds), "expires_at": row.ExpiresAt,
		}},
		Meta: meta,
	}); err != nil {
		return Created{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Created{}, fmt.Errorf("apikeys: commit: %w", err)
	}
	return Created{
		Key: Key{
			ID: row.ID, ProjectID: row.ProjectID, Name: row.Name, Prefix: row.Prefix, Scopes: row.Scopes, AppIDs: row.AppIds,
			RateLimitPerMinute: intPtr(row.RateLimitPerMinute), Environments: row.Environments, CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt,
			CreatedBy: creator(row.CreatorID, row.CreatorName, row.CreatorEmail),
		},
		Raw: raw,
	}, nil
}

// UpdateAccess replaces what the key id of the project projectID may do with
// apps and, when a.SetEnvironments, which environments it may send for, on behalf of user, audits
// api_key.updated and, after the transaction, tells every verifier to forget
// the key so the change applies at once. A revoked or unknown key is
// ErrKeyNotFound; apps:create only applies to ingest keys.
func (s *Service) UpdateAccess(ctx context.Context, user, projectID, id uuid.UUID, a Access) (Key, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Key{}, fmt.Errorf("apikeys: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, projectID)
	if err != nil {
		return Key{}, err
	}
	k, err := q.LockProjectAPIKey(ctx, db.LockProjectAPIKeyParams{ID: id, ProjectID: p.ID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && k.RevokedAt != nil) {
		return Key{}, ErrKeyNotFound
	}
	if err != nil {
		return Key{}, fmt.Errorf("apikeys: lock key: %w", err)
	}
	appIDs, err := checkApps(ctx, q, p.ID, a.AppIDs, s.now())
	if err != nil {
		return Key{}, err
	}
	envs := k.Environments
	if a.SetEnvironments {
		if envs, err = checkEnvironments(ctx, q, p.ID, a.Environments); err != nil {
			return Key{}, err
		}
	}
	scopes := withAppsCreate(k.Scopes, a.CanCreateApps)
	limit := k.RateLimitPerMinute
	if a.RateLimitPerMinute != nil {
		limit = nil
		if *a.RateLimitPerMinute != 0 {
			if limit, err = rateLimit(a.RateLimitPerMinute); err != nil {
				return Key{}, err
			}
		}
	}
	if err := q.UpdateAPIKeyAccess(ctx, db.UpdateAPIKeyAccessParams{ID: k.ID, Scopes: scopes, AppIds: appIDs, RateLimitPerMinute: limit, Environments: envs}); err != nil {
		return Key{}, fmt.Errorf("apikeys: update: %w", err)
	}
	meta := keyMeta(p, k.ID, k.Name, k.Prefix, scopes)
	meta["can_create_apps"] = a.CanCreateApps
	meta["app_ids"] = idStrings(appIDs)
	meta["rate_limit_per_minute"] = intPtr(limit)
	meta["environments"] = envs
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User: &user, Actor: &user, Kind: audit.APIKeyUpdated,
		Org: &p.OrgID, Project: &p.ID, Target: keyTarget(k.ID, k.Name),
		Changes: &audit.Changes{
			Previous: map[string]any{
				"scopes": k.Scopes, "app_ids": idStrings(k.AppIds),
				"rate_limit_per_minute": intPtr(k.RateLimitPerMinute), "environments": k.Environments,
			},
			Next: map[string]any{
				"scopes": scopes, "app_ids": idStrings(appIDs),
				"rate_limit_per_minute": intPtr(limit), "environments": envs,
			},
		},
		Meta: meta,
	}); err != nil {
		return Key{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Key{}, fmt.Errorf("apikeys: commit: %w", err)
	}
	if s.invalidate != nil {
		if err := s.invalidate(ctx, k.KeyHash); err != nil {
			s.logger.WarnContext(ctx, "api key updated but cache invalidation failed; the change applies with the cache TTL",
				"key_id", k.ID, "error", err)
		}
	}
	return Key{
		ID: k.ID, ProjectID: p.ID, Name: k.Name, Prefix: k.Prefix, Scopes: scopes, AppIDs: appIDs, Environments: envs,
		RateLimitPerMinute: intPtr(limit), CreatedAt: k.CreatedAt, ExpiresAt: k.ExpiresAt, LastUsedAt: k.LastUsedAt,
		LastUsedSDK: k.LastUsedSdk, LastUsedIP: k.LastUsedIp, CreatedBy: creator(k.CreatorID, k.CreatorName, k.CreatorEmail),
		RotatedFrom: k.RotatedFrom, RotatedTo: k.RotatedTo,
	}, nil
}

// idStrings renders ids for audit metadata; nil stays nil (every app).
func idStrings(ids []uuid.UUID) []string {
	if ids == nil {
		return nil
	}
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	return out
}

// List returns every key of the project projectID, revoked ones included,
// newest first.
func (s *Service) List(ctx context.Context, projectID uuid.UUID) ([]Key, error) {
	q := db.New(s.pool)
	p, err := q.GetActiveProject(ctx, projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("apikeys: get project: %w", err)
	}
	rows, err := q.ListProjectAPIKeys(ctx, p.ID)
	if err != nil {
		return nil, fmt.Errorf("apikeys: list: %w", err)
	}
	seen, err := q.ListProjectKeyApps(ctx, p.ID)
	if err != nil {
		return nil, fmt.Errorf("apikeys: list key apps: %w", err)
	}
	byKey := map[uuid.UUID][]KeyApp{}
	for _, r := range seen {
		byKey[r.KeyID] = append(byKey[r.KeyID], KeyApp{AppID: r.AppID, Slug: r.AppSlug, Name: r.AppName, FirstSeenAt: r.FirstSeenAt, LastSeenAt: r.LastSeenAt})
	}
	out := make([]Key, 0, len(rows))
	for _, r := range rows {
		out = append(out, Key{
			ID: r.ID, ProjectID: p.ID, Name: r.Name, Prefix: r.Prefix, Scopes: r.Scopes, AppIDs: r.AppIds, Environments: r.Environments,
			RateLimitPerMinute: intPtr(r.RateLimitPerMinute), CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, RevokedAt: r.RevokedAt, LastUsedAt: r.LastUsedAt,
			LastUsedSDK: r.LastUsedSdk, LastUsedIP: r.LastUsedIp, CreatedBy: creator(r.CreatorID, r.CreatorName, r.CreatorEmail),
			AppsSeen: byKey[r.ID], RotatedFrom: r.RotatedFrom, RotatedTo: r.RotatedTo,
		})
	}
	return out, nil
}

// Revoke revokes the key id of the project projectID on behalf of user,
// audits api_key.revoked
// and, after commit, tells every verifier to drop the key from its cache.
// Revoking a key that is already revoked changes nothing; an id the project
// does not have is ErrKeyNotFound.
func (s *Service) Revoke(ctx context.Context, user, projectID, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("apikeys: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, projectID)
	if err != nil {
		return err
	}
	k, err := q.LockProjectAPIKey(ctx, db.LockProjectAPIKeyParams{ID: id, ProjectID: p.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrKeyNotFound
	}
	if err != nil {
		return fmt.Errorf("apikeys: lock key: %w", err)
	}
	if k.RevokedAt != nil {
		return nil
	}
	if _, err := q.RevokeAPIKey(ctx, k.ID); err != nil {
		return fmt.Errorf("apikeys: revoke: %w", err)
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:    &user,
		Actor:   &user,
		Kind:    audit.APIKeyRevoked,
		Org:     &p.OrgID,
		Project: &p.ID,
		Target:  keyTarget(k.ID, k.Name),
		Meta:    keyMeta(p, k.ID, k.Name, k.Prefix, k.Scopes),
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("apikeys: commit: %w", err)
	}
	if s.invalidate != nil {
		// The revocation is committed; a lost invalidation only delays it
		// until the verifiers' cache TTL, so it is logged, not returned.
		if err := s.invalidate(ctx, k.KeyHash); err != nil {
			s.logger.WarnContext(ctx, "api key revoked but cache invalidation failed; it expires with the cache TTL",
				"key_id", k.ID, "error", err)
		}
	}
	return nil
}

// Overlap windows a rotated key keeps working for.
const (
	// OverlapNone: the old key stops working at once.
	OverlapNone = "none"
	// Overlap24h: the old key keeps working for 24 hours.
	Overlap24h = "24h"
	// Overlap7d: the old key keeps working for 7 days (Stripe's maximum).
	Overlap7d = "7d"
)

// Overlaps are the overlap windows Rotate accepts, shortest first.
var Overlaps = []string{OverlapNone, Overlap24h, Overlap7d}

// overlapDuration is how long a rotated key keeps working.
func overlapDuration(overlap string) (time.Duration, error) {
	switch overlap {
	case OverlapNone:
		return 0, nil
	case Overlap24h:
		return 24 * time.Hour, nil
	case Overlap7d:
		return 7 * 24 * time.Hour, nil
	}
	return 0, ErrInvalid
}

// Rotated is the result of a rotation: the successor with its raw value
// (shown once) and the old key with its new expiry.
type Rotated struct {
	Created
	Old Key
}

// Rotate replaces the key id of the active project projectID on behalf of
// user (the caller checks project#manage_keys): it creates a successor with the same
// name, scopes, app scope, environments and rate limit, and sets the old
// key's expires_at to the end of the overlap window (now, +24 h or +7 d,
// never later than the expiry it already had). The two are linked through
// rotated_from and rotated_to. A revoked, expired or already rotated key is
// ErrKeyNotActive. Audited as api_key.rotated with both ids.
//
// With OverlapNone the old key is dropped from every verifier cache after
// commit, so it is rejected at once (at worst within ingest.key_cache_ttl
// when the invalidation is lost). With an overlap the cached key carries its
// expiry and the verifier rejects it from then on.
func (s *Service) Rotate(ctx context.Context, user, projectID, id uuid.UUID, overlap string) (Rotated, error) {
	window, err := overlapDuration(overlap)
	if err != nil {
		return Rotated{}, err
	}
	raw, prefix, hash, err := Generate()
	if err != nil {
		return Rotated{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Rotated{}, fmt.Errorf("apikeys: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, projectID)
	if err != nil {
		return Rotated{}, err
	}
	k, err := q.LockProjectAPIKey(ctx, db.LockProjectAPIKeyParams{ID: id, ProjectID: p.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Rotated{}, ErrKeyNotFound
	}
	if err != nil {
		return Rotated{}, fmt.Errorf("apikeys: lock key: %w", err)
	}
	now := s.now().UTC()
	if k.RevokedAt != nil || k.RotatedTo != nil || (k.ExpiresAt != nil && !k.ExpiresAt.After(now)) {
		return Rotated{}, ErrKeyNotActive
	}
	// With an overlap the project briefly holds one more active key, so the
	// cap applies; without one the successor replaces the key one for one.
	if window > 0 {
		if err := s.checkKeyLimit(ctx, q, p.ID); err != nil {
			return Rotated{}, err
		}
	}
	oldExpires := now.Add(window)
	if k.ExpiresAt != nil && k.ExpiresAt.Before(oldExpires) {
		oldExpires = k.ExpiresAt.UTC()
	}
	row, err := q.CreateAPIKey(ctx, db.CreateAPIKeyParams{
		ID: uuid.New(), ProjectID: p.ID, Name: k.Name, Prefix: prefix, KeyHash: hash, Scopes: k.Scopes, AppIds: k.AppIds,
		CreatedBy: &user, RateLimitPerMinute: k.RateLimitPerMinute, Environments: k.Environments, RotatedFrom: &k.ID,
	})
	if err != nil {
		return Rotated{}, fmt.Errorf("apikeys: create successor: %w", err)
	}
	if err := q.MarkAPIKeyRotated(ctx, db.MarkAPIKeyRotatedParams{ID: k.ID, RotatedTo: &row.ID, ExpiresAt: &oldExpires}); err != nil {
		return Rotated{}, fmt.Errorf("apikeys: mark rotated: %w", err)
	}
	meta := keyMeta(p, k.ID, k.Name, k.Prefix, k.Scopes)
	meta["new_key_id"] = row.ID.String()
	meta["new_prefix"] = row.Prefix
	meta["overlap"] = overlap
	meta["old_expires_at"] = oldExpires
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User: &user, Actor: &user, Kind: audit.APIKeyRotated,
		Org: &p.OrgID, Project: &p.ID, Target: keyTarget(k.ID, k.Name),
		Changes: &audit.Changes{
			Previous: map[string]any{"expires_at": k.ExpiresAt, "rotated_to": nil},
			Next:     map[string]any{"expires_at": oldExpires, "rotated_to": row.ID.String()},
		},
		Meta: meta,
	}); err != nil {
		return Rotated{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Rotated{}, fmt.Errorf("apikeys: commit: %w", err)
	}
	if s.invalidate != nil {
		// Every verifier forgets the old key, so the next request loads its
		// new expiry (and, with no overlap, is rejected).
		if err := s.invalidate(ctx, k.KeyHash); err != nil {
			s.logger.WarnContext(ctx, "api key rotated but cache invalidation failed; the old key's new expiry applies with the cache TTL",
				"key_id", k.ID, "error", err)
		}
	}
	creatorOf := creator(k.CreatorID, k.CreatorName, k.CreatorEmail)
	return Rotated{
		Created: Created{
			Key: Key{
				ID: row.ID, ProjectID: row.ProjectID, Name: row.Name, Prefix: row.Prefix, Scopes: row.Scopes, AppIDs: row.AppIds,
				RateLimitPerMinute: intPtr(row.RateLimitPerMinute), Environments: row.Environments, CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt,
				CreatedBy: creator(row.CreatorID, row.CreatorName, row.CreatorEmail), RotatedFrom: row.RotatedFrom,
			},
			Raw: raw,
		},
		Old: Key{
			ID: k.ID, ProjectID: p.ID, Name: k.Name, Prefix: k.Prefix, Scopes: k.Scopes, AppIDs: k.AppIds, Environments: k.Environments,
			RateLimitPerMinute: intPtr(k.RateLimitPerMinute), CreatedAt: k.CreatedAt, ExpiresAt: &oldExpires, LastUsedAt: k.LastUsedAt,
			LastUsedSDK: k.LastUsedSdk, LastUsedIP: k.LastUsedIp, CreatedBy: creatorOf, RotatedFrom: k.RotatedFrom, RotatedTo: &row.ID,
		},
	}, nil
}

// lockProject row-locks the active project id.
func lockProject(ctx context.Context, q *db.Queries, projectID uuid.UUID) (db.LockActiveProjectRow, error) {
	p, err := q.LockActiveProject(ctx, projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, fmt.Errorf("apikeys: lock project: %w", err)
	}
	return p, nil
}

// keyTarget is the audit target of a key event.
func keyTarget(id uuid.UUID, name string) audit.Target {
	return audit.Target{Type: "api_key", ID: id.String(), Label: name}
}

// keyMeta is the audit metadata of a key event. It never holds the raw key
// or its hash.
func keyMeta(p db.LockActiveProjectRow, id uuid.UUID, name, prefix string, scopes []string) map[string]any {
	return map[string]any{
		"org_id":       p.OrgID.String(),
		"project_id":   p.ID.String(),
		"project_slug": p.Slug,
		"key_id":       id.String(),
		"name":         name,
		"prefix":       prefix,
		"scopes":       scopes,
	}
}
