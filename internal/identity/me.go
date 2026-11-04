package identity

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// MePath is the path of the signed-in user's own account.
const MePath = server.APIPrefix + "/users/me"

// AccountService reads and changes the signed-in user's account;
// *account.Service satisfies it.
type AccountService interface {
	Get(ctx context.Context, id uuid.UUID) (db.User, error)
	Update(ctx context.Context, id uuid.UUID, p account.Patch) (db.User, error)
	Delete(ctx context.Context, id uuid.UUID) (account.Deletion, error)
}

// Preferences are the user's UI preferences.
type Preferences struct {
	Home            string `json:"home,omitempty" enum:"endpoints,requests,exceptions" doc:"Screen a project opens on, chosen during onboarding."`
	LastProjectSlug string `json:"last_project_slug,omitempty" doc:"Slug of the project the user last opened."`
}

// PreferencesPatch is merged into the stored preferences; omitted keys stay
// unchanged.
type PreferencesPatch struct {
	Home            *string `json:"home,omitempty" enum:"endpoints,requests,exceptions" doc:"Screen a project opens on."`
	LastProjectSlug *string `json:"last_project_slug,omitempty" pattern:"^([a-z0-9][a-z0-9-]{0,62})?$" doc:"Slug of the project the user last opened, or empty to clear it. It is not checked against the user's projects; /users/me/context drops one they cannot see."`
}

// Me is the signed-in user as returned by /api/v1/users/me.
type Me struct {
	AuthUser
	Preferences Preferences    `json:"preferences"`
	Onboarding  map[string]any `json:"onboarding" doc:"Onboarding progress, as stored by the onboarding flow."`
	CreatedAt   time.Time      `json:"created_at"`
	AMR         []string       `json:"amr" doc:"How the current session was authenticated (the access token's amr)."`
}

// MeOutput is the response of GET and PATCH /api/v1/users/me.
type MeOutput struct {
	Body Me
}

// MePatchBody is the request body of PATCH /api/v1/users/me. Omitted fields
// stay unchanged.
type MePatchBody struct {
	Name        *string           `json:"name,omitempty" maxLength:"120" doc:"Display name; surrounding whitespace is trimmed."`
	AvatarURL   *string           `json:"avatar_url,omitempty" maxLength:"2048" pattern:"^(https?://\\S+)?$" doc:"An http(s) image URL, or empty to clear it."`
	Preferences *PreferencesPatch `json:"preferences,omitempty"`
}

// MePatchInput is the request of PATCH /api/v1/users/me.
type MePatchInput struct {
	Body MePatchBody
}

// MeDeleteOutput is the response of DELETE /api/v1/users/me.
type MeDeleteOutput struct {
	Body struct {
		DeleteAfter time.Time `json:"delete_after" doc:"When the account is removed for good. Until then it can be restored."`
	}
}

// Account serves GET, PATCH and DELETE /api/v1/users/me.
type Account struct {
	svc    AccountService
	logger *slog.Logger
}

// NewAccount returns the account endpoints over svc.
func NewAccount(svc AccountService, logger *slog.Logger) *Account {
	return &Account{svc: svc, logger: logger}
}

// Register mounts the account operations. They declare the session scheme,
// so authn.Middleware must be installed on api before.
func (a *Account) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "get-me",
		Method:      http.MethodGet,
		Path:        MePath,
		Summary:     "Get the signed-in user",
		Description: "Returns the signed-in user's profile, preferences, onboarding state and how the current session was authenticated (`amr`).",
		Tags:        []string{server.TagUsers},
		Security:    security,
	}, CodeUnauthenticated, CodeSessionExpired, CodeInternal), a.get)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "update-me",
		Method:      http.MethodPatch,
		Path:        MePath,
		Summary:     "Update the signed-in user",
		Description: "Updates the name and avatar, and merges `preferences` into the stored ones (keys not sent stay unchanged). Audited as `user.updated`.",
		Tags:        []string{server.TagUsers},
		Security:    security,
	}, CodeInvalidRequest, CodeUnauthenticated, CodeSessionExpired, CodeInternal), a.update)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "delete-me",
		Method:      http.MethodDelete,
		Path:        MePath,
		Summary:     "Delete the signed-in user",
		Description: "Deletes the account with a 30-day grace period: it is hidden at once, every session is revoked, and it is removed for good after `delete_after`. Refused with `owner_transfer_required` while the user is the only owner of an organization. Audited as `user.deleted`.",
		Tags:        []string{server.TagUsers},
		Security:    security,
	}, CodeOwnerTransferRequired, CodeUnauthenticated, CodeSessionExpired, CodeInternal), a.delete)
}

func (a *Account) get(ctx context.Context, _ *struct{}) (*MeOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	u, err := a.svc.Get(ctx, p.UserID)
	if err != nil {
		return nil, a.fail(ctx, "get me", err)
	}
	return &MeOutput{Body: NewMe(u, p.AMR)}, nil
}

func (a *Account) update(ctx context.Context, in *MePatchInput) (*MeOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	patch := account.Patch{AvatarURL: in.Body.AvatarURL}
	if in.Body.Name != nil {
		name := strings.TrimSpace(*in.Body.Name)
		patch.Name = &name
	}
	if pp := in.Body.Preferences; pp != nil {
		patch.Preferences = map[string]any{}
		if pp.Home != nil {
			patch.Preferences[account.PreferenceHome] = *pp.Home
		}
		if pp.LastProjectSlug != nil {
			patch.Preferences[account.PreferenceLastProject] = *pp.LastProjectSlug
		}
	}
	u, err := a.svc.Update(ctx, p.UserID, patch)
	if err != nil {
		return nil, a.fail(ctx, "update me", err)
	}
	return &MeOutput{Body: NewMe(u, p.AMR)}, nil
}

func (a *Account) delete(ctx context.Context, _ *struct{}) (*MeDeleteOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	d, err := a.svc.Delete(ctx, p.UserID)
	if err != nil {
		return nil, a.fail(ctx, "delete me", err)
	}
	out := &MeDeleteOutput{}
	out.Body.DeleteAfter = d.DeleteAfter.UTC()
	return out, nil
}

// fail maps a service error to its problem. A user deleted while their
// access token is still valid answers session_expired.
func (a *Account) fail(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, account.ErrNotFound):
		return Err(CodeSessionExpired)
	case errors.Is(err, account.ErrOwnerTransferRequired):
		return Err(CodeOwnerTransferRequired)
	case errors.Is(err, account.ErrInvalidPreference):
		return Err(CodeInvalidRequest)
	default:
		a.logger.ErrorContext(ctx, op, "error", err)
		return Err(CodeInternal)
	}
}

// NewMe renders u for the session authenticated with amr. Unreadable stored
// preferences or onboarding state render as empty.
func NewMe(u db.User, amr []string) Me {
	m := Me{
		AuthUser:   NewAuthUser(u),
		Onboarding: map[string]any{},
		CreatedAt:  u.CreatedAt.UTC(),
		AMR:        slices.Clone(amr),
	}
	if m.AMR == nil {
		m.AMR = []string{}
	}
	var prefs Preferences
	if json.Unmarshal(u.Preferences, &prefs) == nil {
		if !slices.Contains(account.Homes, prefs.Home) {
			prefs.Home = ""
		}
		m.Preferences = prefs
	}
	_ = json.Unmarshal(u.Onboarding, &m.Onboarding)
	if m.Onboarding == nil {
		m.Onboarding = map[string]any{}
	}
	return m
}
