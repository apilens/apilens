package identity

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// OnboardingPath is the path of the signed-in user's onboarding state.
const OnboardingPath = MePath + "/onboarding"

// OnboardingService saves the signed-in user's onboarding progress;
// *account.Service satisfies it.
type OnboardingService interface {
	UpdateOnboarding(ctx context.Context, id uuid.UUID, p account.OnboardingPatch) (db.User, error)
}

// OnboardingAnswers are the answers given during onboarding. Unset answers
// are omitted.
type OnboardingAnswers struct {
	OrgSlug     *string `json:"org_slug,omitempty" pattern:"^([a-z0-9][a-z0-9-]{0,62})?$" doc:"Slug of the organization created or joined."`
	ProjectSlug *string `json:"project_slug,omitempty" pattern:"^([a-z0-9][a-z0-9-]{0,62})?$" doc:"Slug of the first project."`
	Language    *string `json:"language,omitempty" pattern:"^([a-z0-9][a-z0-9._+-]{0,31})?$" doc:"Language chosen to instrument, e.g. python."`
	Runtime     *string `json:"runtime,omitempty" pattern:"^([a-z0-9][a-z0-9._+-]{0,31})?$" doc:"Framework or runtime, e.g. fastapi."`
	Method      *string `json:"method,omitempty" pattern:"^([a-z0-9][a-z0-9._+-]{0,31})?$" doc:"Instrumentation method, e.g. sdk or otel."`
	Invited     *int    `json:"invited,omitempty" minimum:"0" maximum:"1000" doc:"Number of teammates invited."`
	APIKeyID    *string `json:"api_key_id,omitempty" pattern:"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$" doc:"Id of the ingest key the install step created; the raw key is never stored."`
}

// OnboardingPatchBody is the request body of PATCH
// /api/v1/users/me/onboarding. Omitted fields stay unchanged.
type OnboardingPatchBody struct {
	Step      *string            `json:"step,omitempty" pattern:"^[a-z][a-z0-9_-]{0,31}$" doc:"The onboarding screen to resume at, e.g. project."`
	Answers   *OnboardingAnswers `json:"answers,omitempty" doc:"Merged key by key into the stored answers; answers not sent stay unchanged."`
	Completed *bool              `json:"completed,omitempty" doc:"true finishes onboarding (completed_at is set the first time); false reopens it."`
}

// OnboardingPatchInput is the request of PATCH /api/v1/users/me/onboarding.
type OnboardingPatchInput struct {
	Body OnboardingPatchBody
}

// Onboarding is the signed-in user's onboarding state.
type Onboarding struct {
	Step        *string           `json:"step" doc:"The onboarding screen to resume at; null before onboarding starts."`
	Completed   bool              `json:"completed" doc:"Whether onboarding is finished."`
	CompletedAt *time.Time        `json:"completed_at" doc:"When onboarding was finished; null while it is not."`
	Answers     OnboardingAnswers `json:"answers"`
}

// OnboardingOutput is the response of PATCH /api/v1/users/me/onboarding.
type OnboardingOutput struct {
	Body Onboarding
}

// OnboardingAPI serves PATCH /api/v1/users/me/onboarding.
type OnboardingAPI struct {
	svc    OnboardingService
	logger *slog.Logger
}

// NewOnboarding returns the onboarding endpoint over svc.
func NewOnboarding(svc OnboardingService, logger *slog.Logger) *OnboardingAPI {
	return &OnboardingAPI{svc: svc, logger: logger}
}

// Register mounts the operation. It declares the session scheme, so
// authn.Middleware must be installed on api before.
func (o *OnboardingAPI) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "update-onboarding",
		Method:      http.MethodPatch,
		Path:        OnboardingPath,
		Summary:     "Save the signed-in user's onboarding progress",
		Description: "Saves where the user is in onboarding so a refresh resumes there: `step` replaces the stored step, `answers` is merged key by key into the stored answers (org_slug, project_slug, language, runtime, method, invited, api_key_id), and `completed` finishes or reopens onboarding. " +
			"Returns the resulting state; `GET /api/v1/users/me/context` reports the same step and completion. Unknown fields fail validation (`422`).",
		Tags:     []string{server.TagUsers},
		Security: []map[string][]string{{authn.SchemeSession: {}}},
	}, CodeInvalidRequest, CodeUnauthenticated, CodeSessionExpired, CodeInternal), o.update)
}

func (o *OnboardingAPI) update(ctx context.Context, in *OnboardingPatchInput) (*OnboardingOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	patch := account.OnboardingPatch{Step: in.Body.Step, Completed: in.Body.Completed}
	if a := in.Body.Answers; a != nil {
		patch.Answers = map[string]any{}
		for k, v := range map[string]*string{
			account.AnswerOrgSlug: a.OrgSlug, account.AnswerProjectSlug: a.ProjectSlug,
			account.AnswerLanguage: a.Language, account.AnswerRuntime: a.Runtime, account.AnswerMethod: a.Method,
			account.AnswerAPIKeyID: a.APIKeyID,
		} {
			if v != nil {
				patch.Answers[k] = *v
			}
		}
		if a.Invited != nil {
			patch.Answers[account.AnswerInvited] = *a.Invited
		}
	}
	u, err := o.svc.UpdateOnboarding(ctx, p.UserID, patch)
	switch {
	case err == nil:
		return &OnboardingOutput{Body: NewOnboardingState(u.Onboarding)}, nil
	case errors.Is(err, account.ErrNotFound):
		return nil, Err(CodeSessionExpired)
	case errors.Is(err, account.ErrInvalidOnboarding):
		return nil, Err(CodeInvalidRequest)
	default:
		o.logger.ErrorContext(ctx, "update onboarding", "error", err)
		return nil, Err(CodeInternal)
	}
}

// NewOnboardingState reads the stored onboarding object. Onboarding is
// completed when `completed` is true or `completed_at` is set (as
// GET /api/v1/users/me/context reads it). Values of the wrong type read as
// unset.
func NewOnboardingState(raw []byte) Onboarding {
	var stored struct {
		Step        any            `json:"step"`
		Completed   any            `json:"completed"`
		CompletedAt any            `json:"completed_at"`
		Answers     map[string]any `json:"answers"`
	}
	var out Onboarding
	if json.Unmarshal(raw, &stored) != nil {
		return out
	}
	if s, ok := stored.Step.(string); ok && s != "" {
		out.Step = &s
	}
	done, _ := stored.Completed.(bool)
	at, _ := stored.CompletedAt.(string)
	out.Completed = done || at != ""
	if t, err := time.Parse(time.RFC3339Nano, at); err == nil {
		t = t.UTC()
		out.CompletedAt = &t
	}
	str := func(k string) *string {
		if s, ok := stored.Answers[k].(string); ok {
			return &s
		}
		return nil
	}
	out.Answers = OnboardingAnswers{
		OrgSlug:     str(account.AnswerOrgSlug),
		ProjectSlug: str(account.AnswerProjectSlug),
		Language:    str(account.AnswerLanguage),
		Runtime:     str(account.AnswerRuntime),
		Method:      str(account.AnswerMethod),
		APIKeyID:    str(account.AnswerAPIKeyID),
	}
	if f, ok := stored.Answers[account.AnswerInvited].(float64); ok && f >= 0 && f <= math.MaxInt32 && f == math.Trunc(f) {
		n := int(f)
		out.Answers.Invited = &n
	}
	return out
}
