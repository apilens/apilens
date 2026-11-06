package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

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
	CanCreateApps bool       `json:"can_create_apps" doc:"Whether data sent with the key creates an app the first time it names one the project does not have. False for keys without apps:create and for keys limited to some apps."`
	AppIDs        []string   `json:"app_ids" required:"true" nullable:"true" doc:"The apps the key may send data for; null means every app of the project."`
	AppsSeen      []KeyApp   `json:"apps_seen" doc:"The apps the key sent data for, most recent first (recorded at most once a minute)."`
	CreatedAt     time.Time  `json:"created_at"`
	ExpiresAt     *time.Time `json:"expires_at" required:"true" nullable:"true" doc:"When the key stops working; null if never."`
	LastUsedAt    *time.Time `json:"last_used_at" required:"true" nullable:"true" doc:"When the key was last used (recorded at most every few minutes); null if never."`
	RevokedAt     *time.Time `json:"revoked_at" required:"true" nullable:"true" doc:"When the key was revoked; null while it is active."`
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
	}
}

// UpdateAPIKeyAccessInput is the request of PUT /api/v1/projects/{slug}/api-keys/{id}/access.
type UpdateAPIKeyAccessInput struct {
	APIKeyInput
	Body struct {
		CanCreateApps bool     `json:"can_create_apps" doc:"Whether data sent with the key creates apps it names that the project does not have (ingest keys only)."`
		AppIDs        []string `json:"app_ids" required:"true" nullable:"true" maxItems:"100" doc:"The apps the key may send data for; null for every app. A limited key never creates apps."`
	}
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

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "create-api-key",
		Method:        http.MethodPost,
		Path:          APIKeysPath,
		DefaultStatus: http.StatusCreated,
		Summary:       "Create an API key",
		Description: "Issues an API key for the project and returns it in full, once: only its hash is stored. Owners, admins and members only. " +
			"Audited as `api_key.created`. " + notMember,
		Tags:     tags,
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), k.create)

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
		Summary:     "Change what an API key may do with apps",
		Description: "Replaces whether the key may create apps (the apps:create scope) and which apps it may send data for (null: every app). " +
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
	return APIKey{
		ID:            key.ID.String(),
		Name:          key.Name,
		Prefix:        key.Prefix,
		Scopes:        scopes,
		CanCreateApps: key.CanCreateApps(),
		AppIDs:        appIDs,
		AppsSeen:      seen,
		CreatedAt:     key.CreatedAt.UTC(),
		ExpiresAt:     utc(key.ExpiresAt),
		LastUsedAt:    utc(key.LastUsedAt),
		RevokedAt:     utc(key.RevokedAt),
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
	key, err := k.svc.UpdateAccess(ctx, uid, in.Slug, id, apikeys.Access{CanCreateApps: in.Body.CanCreateApps, AppIDs: appIDs})
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
