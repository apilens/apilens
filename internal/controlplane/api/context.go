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
	"github.com/apilens/apilens/internal/controlplane/usercontext"
	"github.com/apilens/apilens/internal/identity"
	identitydb "github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// UserContextPath is the path of the signed-in user's context.
const UserContextPath = server.APIPrefix + "/users/me/context"

// ContextService reads the signed-in user's context;
// *usercontext.Service satisfies it.
type ContextService interface {
	Get(ctx context.Context, user uuid.UUID) (usercontext.Context, error)
}

// ContextProject is a project in the user context.
type ContextProject struct {
	ID           string   `json:"id" format:"uuid"`
	Slug         string   `json:"slug"`
	Name         string   `json:"name"`
	Environments []string `json:"environments" doc:"The project's environment names, sorted."`
	AppCount     int      `json:"app_count" minimum:"0" doc:"The number of the project's active (not deleted) apps."`
	Role         string   `json:"role" enum:"admin,editor,viewer" doc:"The signed-in user's effective project role: the highest one any source grants (organization role, project default access, direct grant)."`
}

// ContextOrg is an organization in the user context.
type ContextOrg struct {
	ID       string           `json:"id" format:"uuid"`
	Slug     string           `json:"slug"`
	Name     string           `json:"name"`
	Role     string           `json:"role" enum:"owner,admin,member,viewer" doc:"The signed-in user's role in the organization."`
	Projects []ContextProject `json:"projects" doc:"The organization's active projects the user can view, ordered by name. A restricted project appears only for org owners and admins and people granted a project role."`
}

// OnboardingState is where the user stands in onboarding.
type OnboardingState struct {
	Step      *string `json:"step" doc:"The onboarding step to resume at; null before onboarding starts."`
	Completed bool    `json:"completed" doc:"Whether onboarding is finished."`
}

// UserContext is the response body of GET /api/v1/users/me/context.
type UserContext struct {
	User            identity.Me         `json:"user"`
	Orgs            []ContextOrg        `json:"orgs" doc:"The organizations the user belongs to, ordered by name."`
	LastProjectSlug *string             `json:"last_project_slug" doc:"The project the user last opened (preferences.last_project_slug, set with PATCH /api/v1/users/me); null when unset or no longer visible to the user."`
	Onboarding      OnboardingState     `json:"onboarding"`
	Capabilities    map[string][]string `json:"capabilities" doc:"Per project slug, the actions the user may perform there (project.read, project.update, project.delete, api_keys.create, api_keys.revoke, capture.manage, alerts.manage, access.manage, audit.read, members.invite, members.remove, billing.manage). Every project in orgs has an entry, listing actions in this order. Computed from SpiceDB; the UI gates on these, the server still checks every request."`
}

// UserContextOutput is the response of GET /api/v1/users/me/context.
type UserContextOutput struct {
	Body UserContext
}

// Context serves GET /api/v1/users/me/context.
type Context struct {
	svc    ContextService
	logger *slog.Logger
}

// NewContext returns the user context endpoint over svc.
func NewContext(svc ContextService, logger *slog.Logger) *Context {
	return &Context{svc: svc, logger: logger}
}

// Register mounts the operation. It declares the session scheme, so
// authn.Middleware must be installed on api before.
func (c *Context) Register(api huma.API) {
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-user-context",
		Method:      http.MethodGet,
		Path:        UserContextPath,
		Summary:     "Get the signed-in user's context",
		Description: "Returns in one call what the app shell needs: the user, their organizations with their role and each organization's projects and environments, the last opened project, the onboarding state and, per project, the actions the user may perform. " +
			"Capabilities are computed with one SpiceDB `CheckBulkPermissions` call; when SpiceDB cannot answer, the call fails with `authz_unavailable` rather than returning partial capabilities. " +
			"A user deleted while their access token is still valid answers `session_expired`.",
		Tags:     []string{server.TagUsers},
		Security: []map[string][]string{{authn.SchemeSession: {}}},
	}, identity.CodeUnauthenticated, identity.CodeSessionExpired, identity.CodeAuthzUnavailable, identity.CodeInternal), c.get)
}

func (c *Context) get(ctx context.Context, _ *struct{}) (*UserContextOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	uc, err := c.svc.Get(ctx, p.UserID)
	if errors.Is(err, usercontext.ErrNotFound) {
		return nil, identity.Err(identity.CodeSessionExpired)
	}
	if errors.Is(err, authz.ErrUnavailable) {
		// Fail closed: no context rather than one with missing capabilities.
		c.logger.WarnContext(ctx, "get user context: capabilities unavailable", "error", err)
		return nil, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	}
	if err != nil {
		c.logger.ErrorContext(ctx, "get user context", "error", err)
		return nil, identity.Err(identity.CodeInternal)
	}
	return &UserContextOutput{Body: toUserContext(uc, p.AMR)}, nil
}

func toUserContext(uc usercontext.Context, amr []string) UserContext {
	out := UserContext{
		User:         identity.NewMe(identitydb.User(uc.User), amr),
		Orgs:         make([]ContextOrg, 0, len(uc.Orgs)),
		Onboarding:   onboardingState(uc.User.Onboarding),
		Capabilities: uc.Capabilities,
	}
	if out.Capabilities == nil {
		out.Capabilities = map[string][]string{}
	}
	if uc.LastProjectSlug != "" {
		out.LastProjectSlug = &uc.LastProjectSlug
	}
	for _, o := range uc.Orgs {
		org := ContextOrg{
			ID: o.ID.String(), Slug: o.Slug, Name: o.Name, Role: o.Role,
			Projects: make([]ContextProject, 0, len(o.Projects)),
		}
		for _, pr := range o.Projects {
			envs := pr.Environments
			if envs == nil {
				envs = []string{}
			}
			org.Projects = append(org.Projects, ContextProject{ID: pr.ID.String(), Slug: pr.Slug, Name: pr.Name, Environments: envs, AppCount: pr.AppCount, Role: pr.Role})
		}
		out.Orgs = append(out.Orgs, org)
	}
	return out
}

// onboardingState reads the step and completion from the stored onboarding
// object (written by the onboarding flow): `step` is a string, and onboarding
// is completed when `completed` is true or `completed_at` is set.
// Unreadable state reads as not started.
func onboardingState(raw []byte) OnboardingState {
	var stored struct {
		Step        any `json:"step"`
		Completed   any `json:"completed"`
		CompletedAt any `json:"completed_at"`
	}
	var out OnboardingState
	if json.Unmarshal(raw, &stored) != nil {
		return out
	}
	if s, ok := stored.Step.(string); ok && s != "" {
		out.Step = &s
	}
	done, _ := stored.Completed.(bool)
	at, _ := stored.CompletedAt.(string)
	out.Completed = done || at != ""
	return out
}
