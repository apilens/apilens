package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the project API key endpoints.
const (
	APIKeysPath = ProjectPath + "/api-keys"
	APIKeyPath  = APIKeysPath + "/{id}"
	// APIKeyAccessPath is what a key may do with apps.
	APIKeyAccessPath = APIKeyPath + "/access"
)

// APIKeyService creates, lists and revokes project API keys;
// *apikeys.Service satisfies it.
type APIKeyService interface {
	CreateKey(ctx context.Context, user uuid.UUID, slug string, k apikeys.NewKey) (apikeys.Created, error)
	List(ctx context.Context, user uuid.UUID, slug string) ([]apikeys.Key, error)
	UpdateAccess(ctx context.Context, user uuid.UUID, slug string, id uuid.UUID, a apikeys.Access) (apikeys.Key, error)
	Revoke(ctx context.Context, user uuid.UUID, slug string, id uuid.UUID) error
}

// APIKey is a project API key as listed to members. The raw key is never
// returned after creation.
type APIKey struct {
	ID     string   `json:"id" format:"uuid"`
	Name   string   `json:"name"`
	Prefix string   `json:"prefix" doc:"The first characters of the key, for recognising it."`
	Scopes []string `json:"scopes" doc:"What the key may do: ingest (send telemetry), apps:create (ingest may create an app from an app name it has not seen), read (query the project's data)."`
	// CanCreateApps is apps:create on a key not limited to some apps.
	CanCreateApps bool        `json:"can_create_apps" doc:"Whether data sent with the key creates an app the first time it names one the project does not have. False for keys without apps:create and for keys limited to some apps."`
	AppIDs        []string    `json:"app_ids" required:"true" nullable:"true" doc:"The apps the key may send data for; null means every app of the project."`
	Environments  []string    `json:"environments" required:"true" nullable:"true" doc:"The environments the key may send data for; null means every environment. The ingest edge rejects records for any other environment (environment_not_allowed) and stores the rest of the batch."`
	AppsSeen      []KeyApp    `json:"apps_seen" doc:"The apps the key sent data for, most recent first (recorded at most once a minute)."`
	CreatedAt     time.Time   `json:"created_at"`
	CreatedBy     *KeyCreator `json:"created_by,omitempty" doc:"Who created the key; absent when unknown (keys older than this field with no audit record) or once their account is deleted."`
	ExpiresAt     *time.Time  `json:"expires_at" required:"true" nullable:"true" doc:"When the key stops working; null if never."`
	LastUsedAt    *time.Time  `json:"last_used_at" required:"true" nullable:"true" doc:"When the key was last used (recorded at most every few minutes); null if never."`
	LastUsedSDK   *string     `json:"last_used_sdk" required:"true" nullable:"true" doc:"The SDK name and version (User-Agent product) of the last ingest request, recorded with last_used_at; null if never used for ingest or the client sent none. Example: apilenss/0.5.0."`
	LastUsedIP    *string     `json:"last_used_ip" required:"true" nullable:"true" doc:"The client IP of the last ingest request, recorded with last_used_at; null if never used for ingest or when the install does not record it (ingest.record_key_ip false)."`
	RevokedAt     *time.Time  `json:"revoked_at" required:"true" nullable:"true" doc:"When the key was revoked; null while it is active."`
	// RateLimitPerMinute is the per-key ingest rate limit.
	RateLimitPerMinute *int `json:"rate_limit_per_minute" required:"true" nullable:"true" doc:"The most records (requests, logs, spans, deploys) the ingest edge accepts with this key per minute, on top of the project quota; over it ingest answers 429 quota_exceeded with Retry-After. Null: no per-key limit."`
}

// KeyCreator is the user who created an API key.
type KeyCreator struct {
	ID   string `json:"id" format:"uuid"`
	Name string `json:"name" doc:"The user's name, or their email when they have not set one."`
}

// KeyApp is an app a key sent data for.
type KeyApp struct {
	AppID       string    `json:"app_id" format:"uuid"`
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	FirstSeenAt time.Time `json:"first_seen_at"`
	LastSeenAt  time.Time `json:"last_seen_at"`
}

// CreatedAPIKey is a new key with its raw value.
type CreatedAPIKey struct {
	APIKey
	Key string `json:"key" doc:"The full API key. It is shown only in this response: store it now, it cannot be retrieved again."`
}

// CreateAPIKeyInput is the request of POST /api/v1/projects/{slug}/api-keys.
type CreateAPIKeyInput struct {
	ProjectSlugInput
	Body struct {
		Name          string     `json:"name" minLength:"1" maxLength:"100" doc:"Display name; surrounding spaces are trimmed."`
		Scopes        []string   `json:"scopes" minItems:"1" maxItems:"2" uniqueItems:"true" enum:"ingest,read" doc:"What the key may do: ingest (send telemetry), read (query the project's data)."`
		ExpiresAt     *time.Time `json:"expires_at,omitempty" doc:"When the key stops working; must be in the future. Omit for a key that does not expire."`
		CanCreateApps *bool      `json:"can_create_apps,omitempty" doc:"For an ingest key: whether data sent with it creates an app the first time it names one the project does not have (adds the apps:create scope). Defaults to true."`
		AppIDs        []string   `json:"app_ids,omitempty" maxItems:"100" doc:"Limit the key to these apps of the project; omit for every app. A limited key never creates apps."`
		// RateLimitPerMinute is the per-key ingest rate limit; omitted: none.
		RateLimitPerMinute *int `json:"rate_limit_per_minute,omitempty" minimum:"1" maximum:"100000000" doc:"The most records the ingest edge accepts with this key per minute, on top of the project quota (429 quota_exceeded with Retry-After over it). Omit for no per-key limit."`
		// Environments pins the key to some environments; omitted: every one.
		Environments []string `json:"environments,omitempty" minItems:"1" maxItems:"50" doc:"Pin the key to these environments of the project (names it already has); omit for every environment. Ingest rejects records for other environments."`
	}
}

// UpdateAPIKeyAccessInput is the request of PUT /api/v1/projects/{slug}/api-keys/{id}/access.
type UpdateAPIKeyAccessInput struct {
	APIKeyInput
	Body struct {
		CanCreateApps bool     `json:"can_create_apps" doc:"Whether data sent with the key creates apps it names that the project does not have (ingest keys only)."`
		AppIDs        []string `json:"app_ids" required:"true" nullable:"true" maxItems:"100" doc:"The apps the key may send data for; null for every app. A limited key never creates apps."`
		// RateLimitPerMinute replaces the per-key ingest rate limit; 0
		// removes it, omitted keeps it.
		RateLimitPerMinute *int `json:"rate_limit_per_minute,omitempty" minimum:"0" maximum:"100000000" doc:"The most records the ingest edge accepts with this key per minute; 0 removes the per-key limit. Omit to keep the current limit."`
		// Environments replaces the pin when present; null: every environment.
		Environments []string `json:"environments,omitempty" nullable:"true" maxItems:"50" doc:"The environments the key may send data for (names the project has); null for every environment. Omit to keep the key's current environments."`
	}
	// RawBody tells an omitted environments field from null.
	RawBody []byte
}

// APIKeyOutput is a single key.
type APIKeyOutput struct {
	Body APIKey
}

// CreateAPIKeyOutput is the response of POST /api/v1/projects/{slug}/api-keys.
type CreateAPIKeyOutput struct {
	Body CreatedAPIKey
}

// ListAPIKeysOutput is the response of GET /api/v1/projects/{slug}/api-keys.
type ListAPIKeysOutput struct {
	Body []APIKey
}

// APIKeyInput names a project API key in the path.
type APIKeyInput struct {
	ProjectSlugInput
	ID string `path:"id" format:"uuid" doc:"The key's id."`
}

// APIKeys serves the project API key endpoints.
type APIKeys struct {
	svc    APIKeyService
	logger *slog.Logger
	// recentAuth is the sign-in age sensitive operations allow
	// (identity.sensitive_action_max_age); 0 means authz.DefaultRecentAuth.
	recentAuth time.Duration
}

// WithRecentAuth sets the sign-in age sensitive operations (create) allow
// and returns k.
func (k *APIKeys) WithRecentAuth(maxAge time.Duration) *APIKeys {
	k.recentAuth = maxAge
	return k
}

// NewAPIKeys returns the API key endpoints over svc.
func NewAPIKeys(svc APIKeyService, logger *slog.Logger) *APIKeys {
	return &APIKeys{svc: svc, logger: logger}
}

// Register mounts the API key operations. They declare the session scheme,
// so authn.Middleware must be installed on api before.
func (k *APIKeys) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	tags := []string{server.TagProjects}
	notMember := "Answers `forbidden` (403) when the project does not exist or the user is not a member of its organization, so the cases cannot be told apart."
	recentAuth := "Needs a sign-in less than `identity.sensitive_action_max_age` (10 minutes) old: an older session answers `reauth_required` (403) and the user signs in again. "

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "create-api-key",
		Method:        http.MethodPost,
		Path:          APIKeysPath,
		DefaultStatus: http.StatusCreated,
		Summary:       "Create an API key",
		Description: "Issues an API key for the project and returns it in full, once: only its hash is stored. Owners, admins and members only. " +
			"A project has at most `ingest.max_keys_per_project` (default 50) active keys: past that it answers `key_limit_reached` (409) until one is revoked or expires. " +
			"Audited as `api_key.created`. " + recentAuth + notMember,
		Tags:        tags,
		Security:    security,
		Middlewares: huma.Middlewares{authz.RequireRecentAuth(api, k.recentAuth)},
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeReauthRequired, identity.CodeKeyLimitReached, identity.CodeInternal), k.create)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-api-keys",
		Method:      http.MethodGet,
		Path:        APIKeysPath,
		Summary:     "List a project's API keys",
		Description: "Lists the project's API keys, revoked ones included, newest first. Keys are shown by prefix; the full key is never returned again. " + notMember,
		Tags:        tags,
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), k.list)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "update-api-key-access",
		Method:      http.MethodPut,
		Path:        APIKeyAccessPath,
		Summary:     "Change what an API key may do with apps and environments, and its rate limit",
		Description: "Replaces whether the key may create apps (the apps:create scope) and which apps it may send data for (null: every app), " +
			"sets its ingest rate limit when `rate_limit_per_minute` is sent (0 removes it) and, when `environments` is present, " +
			"which environments it may send data for (null: every environment; an environment the project does not have answers `invalid_request`). " +
			"Every process forgets the cached key, so the change applies to the next request. A revoked key or an id the project does not have answers `api_key_gone` (410); " +
			"an app id the project does not have answers `invalid_request`. Owners, admins and members only. Audited as `api_key.updated`. " + notMember,
		Tags:     tags,
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeAPIKeyGone, identity.CodeInternal), k.updateAccess)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "revoke-api-key",
		Method:        http.MethodDelete,
		Path:          APIKeyPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Revoke an API key",
		Description: "Revokes the key: the ingest edge and query API reject it from then on (every process drops it from its cache through Valkey). " +
			"Revoking a revoked key changes nothing; an id the project does not have answers `api_key_gone` (410). Owners, admins and members only. " +
			"Audited as `api_key.revoked`. " + notMember,
		Tags:     tags,
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeAPIKeyGone, identity.CodeInternal), k.revoke)
}

func toAPIKey(key apikeys.Key) APIKey {
	scopes := key.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	seen := make([]KeyApp, 0, len(key.AppsSeen))
	for _, s := range key.AppsSeen {
		seen = append(seen, KeyApp{AppID: s.AppID.String(), Slug: s.Slug, Name: s.Name, FirstSeenAt: s.FirstSeenAt.UTC(), LastSeenAt: s.LastSeenAt.UTC()})
	}
	var appIDs []string
	if key.AppIDs != nil {
		appIDs = make([]string, len(key.AppIDs))
		for i, id := range key.AppIDs {
			appIDs[i] = id.String()
		}
	}
	var createdBy *KeyCreator
	if key.CreatedBy != nil {
		createdBy = &KeyCreator{ID: key.CreatedBy.ID.String(), Name: key.CreatedBy.Name}
	}
	var lastIP *string
	if key.LastUsedIP != nil {
		s := key.LastUsedIP.String()
		lastIP = &s
	}
	return APIKey{
		ID:            key.ID.String(),
		Name:          key.Name,
		Prefix:        key.Prefix,
		Scopes:        scopes,
		CanCreateApps: key.CanCreateApps(),
		AppIDs:        appIDs,
		Environments:  key.Environments,
		AppsSeen:      seen,
		CreatedAt:     key.CreatedAt.UTC(),
		CreatedBy:     createdBy,
		ExpiresAt:     utc(key.ExpiresAt),
		LastUsedAt:    utc(key.LastUsedAt),
		LastUsedSDK:   key.LastUsedSDK,
		LastUsedIP:    lastIP,
		RevokedAt:     utc(key.RevokedAt),

		RateLimitPerMinute: key.RateLimitPerMinute,
	}
}

func utc(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// problem maps an error of apikeys.Service to a problem.
func (k *APIKeys) problem(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, apikeys.ErrNotFound), errors.Is(err, apikeys.ErrForbidden):
		return identity.Err(identity.CodeForbidden)
	case errors.Is(err, apikeys.ErrKeyNotFound):
		return identity.Err(identity.CodeAPIKeyGone)
	case errors.Is(err, apikeys.ErrKeyLimit):
		return identity.Err(identity.CodeKeyLimitReached)
	case errors.Is(err, apikeys.ErrInvalid):
		return identity.Err(identity.CodeInvalidRequest)
	default:
		k.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func (k *APIKeys) create(ctx context.Context, in *CreateAPIKeyInput) (*CreateAPIKeyOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	appIDs, err := parseIDs(in.Body.AppIDs)
	if err != nil {
		return nil, err
	}
	c, err := k.svc.CreateKey(ctx, uid, in.Slug, apikeys.NewKey{
		Name: in.Body.Name, Scopes: in.Body.Scopes, ExpiresAt: in.Body.ExpiresAt, CanCreateApps: in.Body.CanCreateApps, AppIDs: appIDs,
		RateLimitPerMinute: in.Body.RateLimitPerMinute, Environments: in.Body.Environments,
	})
	if err != nil {
		return nil, k.problem(ctx, "create api key", err)
	}
	return &CreateAPIKeyOutput{Body: CreatedAPIKey{APIKey: toAPIKey(c.Key), Key: c.Raw}}, nil
}

func (k *APIKeys) list(ctx context.Context, in *ProjectSlugInput) (*ListAPIKeysOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	list, err := k.svc.List(ctx, uid, in.Slug)
	if err != nil {
		return nil, k.problem(ctx, "list api keys", err)
	}
	out := &ListAPIKeysOutput{Body: make([]APIKey, 0, len(list))}
	for _, key := range list {
		out.Body = append(out.Body, toAPIKey(key))
	}
	return out, nil
}

// parseIDs parses app ids; nil stays nil (every app).
func parseIDs(in []string) ([]uuid.UUID, error) {
	if in == nil {
		return nil, nil
	}
	out := make([]uuid.UUID, len(in))
	for i, s := range in {
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, identity.Err(identity.CodeInvalidRequest)
		}
		out[i] = id
	}
	return out, nil
}

func (k *APIKeys) updateAccess(ctx context.Context, in *UpdateAPIKeyAccessInput) (*APIKeyOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	appIDs, err := parseIDs(in.Body.AppIDs)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(in.RawBody, &fields); err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	_, setEnvs := fields["environments"]
	key, err := k.svc.UpdateAccess(ctx, uid, in.Slug, id, apikeys.Access{
		CanCreateApps: in.Body.CanCreateApps, AppIDs: appIDs, RateLimitPerMinute: in.Body.RateLimitPerMinute,
		Environments: in.Body.Environments, SetEnvironments: setEnvs,
	})
	if err != nil {
		return nil, k.problem(ctx, "update api key access", err)
	}
	return &APIKeyOutput{Body: toAPIKey(key)}, nil
}

func (k *APIKeys) revoke(ctx context.Context, in *APIKeyInput) (*struct{}, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	if err := k.svc.Revoke(ctx, uid, in.Slug, id); err != nil {
		return nil, k.problem(ctx, "revoke api key", err)
	}
	return nil, nil
}
