package apikeys

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/projects"
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

// MaxNameLen bounds a key's display name.
const MaxNameLen = 100

// Errors returned by Service.
var (
	// ErrInvalid: the name, scopes or expiry are unusable.
	ErrInvalid = errors.New("apikeys: invalid name, scopes or expiry")
	// ErrNotFound: no active project has the slug, or the user is not a
	// member of its organization. The cases are deliberately
	// indistinguishable.
	ErrNotFound = errors.New("apikeys: project not found")
	// ErrForbidden: the user is a member but their role does not allow the
	// change.
	ErrForbidden = errors.New("apikeys: forbidden")
	// ErrKeyNotFound: the project has no key with the id.
	ErrKeyNotFound = errors.New("apikeys: key not found")
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
	// AppsSeen are the apps the key sent records for, most recent first
	// (List only).
	AppsSeen []KeyApp
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
}

// Access is what an existing key may do with apps.
type Access struct {
	CanCreateApps bool
	AppIDs        []uuid.UUID // nil: every app
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

// CanManage reports whether an organization role may create and revoke a
// project's keys (authz/schema.zed project.manage_keys: everyone who can
// create projects in the organization).
func CanManage(role string) bool { return projects.CanWrite(role) }

// Service creates, lists and revokes the API keys of projects on behalf of
// signed-in users.
//
// Role checks read memberships until the authz middleware lands; they follow
// authz/schema.zed: any member may list keys, owners, admins and members may
// create and revoke them (manage_keys).
type Service struct {
	pool       *pgxpool.Pool
	audit      Auditor
	invalidate Invalidator
	logger     *slog.Logger
	now        func() time.Time
}

// NewService returns a Service over pool. invalidate may be nil, in which
// case a revoked key stays usable until verifier caches expire it.
func NewService(pool *pgxpool.Pool, auditor Auditor, invalidate Invalidator, logger *slog.Logger) *Service {
	return &Service{pool: pool, audit: auditor, invalidate: invalidate, logger: logger, now: time.Now}
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

// Create issues a key named name with scopes for the project slug on behalf
// of user, who must be an owner, admin or member of its organization. name
// is trimmed; expiresAt, when set, must be in the future. The raw key is
// returned once and only its hash is stored. Audited as api_key.created.
func (s *Service) Create(ctx context.Context, user uuid.UUID, slug, name string, scopes []string, expiresAt *time.Time) (Created, error) {
	return s.CreateKey(ctx, user, slug, NewKey{Name: name, Scopes: scopes, ExpiresAt: expiresAt})
}

// CreateKey is Create with app permissions: an ingest key may create apps
// unless k.CanCreateApps is false, and k.AppIDs limits it to some apps.
func (s *Service) CreateKey(ctx context.Context, user uuid.UUID, slug string, k NewKey) (Created, error) {
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
	p, err := lockProject(ctx, q, user, slug, CanManage)
	if err != nil {
		return Created{}, err
	}
	appIDs, err := checkApps(ctx, q, p.ID, k.AppIDs, s.now())
	if err != nil {
		return Created{}, err
	}
	row, err := q.CreateAPIKey(ctx, db.CreateAPIKeyParams{
		ID: uuid.New(), ProjectID: p.ID, Name: name, Prefix: prefix, KeyHash: hash, Scopes: scopes, ExpiresAt: expiresAt, AppIds: appIDs,
	})
	if err != nil {
		return Created{}, fmt.Errorf("apikeys: create: %w", err)
	}
	meta := keyMeta(p, row.ID, row.Name, row.Prefix, row.Scopes)
	meta["app_ids"] = idStrings(row.AppIds)
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.APIKeyCreated,
		Meta:  meta,
	}); err != nil {
		return Created{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Created{}, fmt.Errorf("apikeys: commit: %w", err)
	}
	return Created{
		Key: Key{
			ID: row.ID, ProjectID: row.ProjectID, Name: row.Name, Prefix: row.Prefix, Scopes: row.Scopes, AppIDs: row.AppIds,
			CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt,
		},
		Raw: raw,
	}, nil
}

// UpdateAccess replaces what the key id of the project slug may do with
// apps, on behalf of user (who must be allowed to manage keys), audits
// api_key.updated and, after the transaction, tells every verifier to forget
// the key so the change applies at once. A revoked or unknown key is
// ErrKeyNotFound; apps:create only applies to ingest keys.
func (s *Service) UpdateAccess(ctx context.Context, user uuid.UUID, slug string, id uuid.UUID, a Access) (Key, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Key{}, fmt.Errorf("apikeys: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, user, slug, CanManage)
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
	scopes := withAppsCreate(k.Scopes, a.CanCreateApps)
	if err := q.UpdateAPIKeyAccess(ctx, db.UpdateAPIKeyAccessParams{ID: k.ID, Scopes: scopes, AppIds: appIDs}); err != nil {
		return Key{}, fmt.Errorf("apikeys: update: %w", err)
	}
	meta := keyMeta(p, k.ID, k.Name, k.Prefix, scopes)
	meta["can_create_apps"] = a.CanCreateApps
	meta["app_ids"] = idStrings(appIDs)
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{User: &user, Actor: &user, Kind: audit.APIKeyUpdated, Meta: meta}); err != nil {
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
		ID: k.ID, ProjectID: p.ID, Name: k.Name, Prefix: k.Prefix, Scopes: scopes, AppIDs: appIDs,
		CreatedAt: k.CreatedAt, ExpiresAt: k.ExpiresAt, LastUsedAt: k.LastUsedAt,
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

// List returns every key of the project slug, revoked ones included, newest
// first. user must be a member of the project's organization.
func (s *Service) List(ctx context.Context, user uuid.UUID, slug string) ([]Key, error) {
	q := db.New(s.pool)
	p, err := q.GetMemberProject(ctx, db.GetMemberProjectParams{UserID: user, Slug: slug})
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
			ID: r.ID, ProjectID: p.ID, Name: r.Name, Prefix: r.Prefix, Scopes: r.Scopes, AppIDs: r.AppIds,
			CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, RevokedAt: r.RevokedAt, LastUsedAt: r.LastUsedAt,
			AppsSeen: byKey[r.ID],
		})
	}
	return out, nil
}

// Revoke revokes the key id of the project slug on behalf of user, who must
// be an owner, admin or member of its organization, audits api_key.revoked
// and, after commit, tells every verifier to drop the key from its cache.
// Revoking a key that is already revoked changes nothing; an id the project
// does not have is ErrKeyNotFound.
func (s *Service) Revoke(ctx context.Context, user uuid.UUID, slug string, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("apikeys: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, user, slug, CanManage)
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
		User:  &user,
		Actor: &user,
		Kind:  audit.APIKeyRevoked,
		Meta:  keyMeta(p, k.ID, k.Name, k.Prefix, k.Scopes),
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

// lockProject row-locks the project slug for user's membership in its
// organization and checks the role with allowed.
func lockProject(ctx context.Context, q *db.Queries, user uuid.UUID, slug string, allowed func(string) bool) (db.LockMemberProjectRow, error) {
	p, err := q.LockMemberProject(ctx, db.LockMemberProjectParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, fmt.Errorf("apikeys: lock project: %w", err)
	}
	if !allowed(p.Role) {
		return p, ErrForbidden
	}
	return p, nil
}

// keyMeta is the audit metadata of a key event. It never holds the raw key
// or its hash.
func keyMeta(p db.LockMemberProjectRow, id uuid.UUID, name, prefix string, scopes []string) map[string]any {
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
