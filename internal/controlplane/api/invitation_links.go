package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the invitation link endpoints. They live under /api/v1/auth, so
// they are served by the role that serves sign-in (identity).
const (
	InvitationLinkPath   = identity.AuthPrefix + "/invitations/{token}"
	AcceptInvitationPath = InvitationLinkPath + "/accept"
)

// InvitationLinkService looks up and accepts invitations by their emailed
// token; *orgs.InvitationService satisfies it.
type InvitationLinkService interface {
	Lookup(ctx context.Context, token string) (orgs.InvitationPreview, error)
	Accept(ctx context.Context, user uuid.UUID, token string) (orgs.AcceptedInvitation, error)
}

// InvitationTokenInput names an invitation by its emailed token.
type InvitationTokenInput struct {
	Token string `path:"token" minLength:"1" maxLength:"128" doc:"The token of the invitation link (/invite/{token})."`
}

// InvitationOrg is the organization an invitation is to.
type InvitationOrg struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// InvitationPreview is what the invitation page shows before sign-in.
type InvitationPreview struct {
	Org         InvitationOrg `json:"org"`
	InviterName string        `json:"inviter_name" doc:"Who sent the invitation (their name, or email when they have none); empty once their account is gone."`
	EmailMasked string        `json:"email_masked" doc:"The invited address with most of its local part hidden (a***@example.com)."`
	Role        string        `json:"role" enum:"admin,member,viewer" doc:"The role the invitee joins with."`
	ExpiresAt   time.Time     `json:"expires_at" doc:"When the link stops working."`
}

// InvitationPreviewOutput is the response of GET
// /api/v1/auth/invitations/{token}.
type InvitationPreviewOutput struct {
	Body InvitationPreview
}

// AcceptedInvitation is the response body of POST
// /api/v1/auth/invitations/{token}/accept.
type AcceptedInvitation struct {
	Org    Org  `json:"org" doc:"The organization, with the user's role in it."`
	Joined bool `json:"joined" doc:"Whether this call made the user a member; false when the invitation was already accepted or the user already belonged to the organization."`
}

// AcceptInvitationOutput is the response of POST
// /api/v1/auth/invitations/{token}/accept.
type AcceptInvitationOutput struct {
	Body AcceptedInvitation
}

// InvitationLinks serves the public invitation lookup and the authenticated
// accept.
type InvitationLinks struct {
	svc     InvitationLinkService
	limiter *ratelimit.Limiter
	perIP   ratelimit.Rate
	logger  *slog.Logger
}

// NewInvitationLinks returns the invitation link endpoints over svc. limiter
// enforces perIP (identity.rate_limits.invitation_lookup_per_ip) on the
// public lookup.
func NewInvitationLinks(svc InvitationLinkService, limiter *ratelimit.Limiter, perIP ratelimit.Rate, logger *slog.Logger) *InvitationLinks {
	return &InvitationLinks{svc: svc, limiter: limiter, perIP: perIP, logger: logger}
}

// Register mounts the invitation link operations. Accept declares the
// session scheme, so authn.Middleware must be installed on api before.
func (h *InvitationLinks) Register(api huma.API) {
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-invitation",
		Method:      http.MethodGet,
		Path:        InvitationLinkPath,
		Summary:     "Look up an invitation by its link",
		Description: "Public. The `/invite/{token}` page calls it before asking the invitee to sign in: it shows the organization, the inviter, the invited address (masked), the role and the expiry. " +
			"An unknown token answers `invalid_token`; an expired, revoked or accepted invitation answers `invite_expired`. Rate-limited per client IP (429 `rate_limited` with Retry-After).",
		Tags:        []string{server.TagAuth},
		Middlewares: huma.Middlewares{h.limiter.Limit(api, "invitation_lookup", h.perIP, ratelimit.Key{})},
	}, identity.CodeInvalidRequest, identity.CodeInvalidToken, identity.CodeInviteExpired, identity.CodeRateLimited, identity.CodeInternal), h.lookup)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "accept-invitation",
		Method:      http.MethodPost,
		Path:        AcceptInvitationPath,
		Summary:     "Accept an invitation",
		Description: "Makes the signed-in user a member of the invitation's organization with its role and marks the invitation accepted. " +
			"The user's verified email must be the invited address (403 `invite_email_mismatch`). A user who already belongs to the organization keeps their role. " +
			"Accepting an invitation that the user already accepted answers the organization again (`joined` false). " +
			"An unknown token answers `invalid_token`; an expired or revoked invitation answers `invite_expired`. Audited as `invitation.accepted`.",
		Tags:     []string{server.TagAuth},
		Security: []map[string][]string{{authn.SchemeSession: {}}},
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeInvalidToken, identity.CodeSessionExpired,
		identity.CodeInviteEmailMismatch, identity.CodeInviteExpired, identity.CodeInternal), h.accept)
}

// problem maps an error of a lookup or accept to a problem.
func (h *InvitationLinks) problem(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, orgs.ErrInvitationTokenInvalid):
		return identity.Err(identity.CodeInvalidToken)
	case errors.Is(err, orgs.ErrInvitationExpired):
		return identity.Err(identity.CodeInviteExpired)
	case errors.Is(err, orgs.ErrInviteEmailMismatch):
		return identity.Err(identity.CodeInviteEmailMismatch)
	case errors.Is(err, orgs.ErrUserGone):
		return identity.Err(identity.CodeSessionExpired)
	default:
		h.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func (h *InvitationLinks) lookup(ctx context.Context, in *InvitationTokenInput) (*InvitationPreviewOutput, error) {
	p, err := h.svc.Lookup(ctx, in.Token)
	if err != nil {
		return nil, h.problem(ctx, "look up invitation", err)
	}
	return &InvitationPreviewOutput{Body: InvitationPreview{
		Org:         InvitationOrg{Name: p.OrgName, Slug: p.OrgSlug},
		InviterName: p.InviterName,
		EmailMasked: p.EmailMasked,
		Role:        p.Role,
		ExpiresAt:   p.ExpiresAt.UTC(),
	}}, nil
}

func (h *InvitationLinks) accept(ctx context.Context, in *InvitationTokenInput) (*AcceptInvitationOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	a, err := h.svc.Accept(ctx, uid, in.Token)
	if err != nil {
		return nil, h.problem(ctx, "accept invitation", err)
	}
	return &AcceptInvitationOutput{Body: AcceptedInvitation{Org: toOrg(a.Org), Joined: a.Joined}}, nil
}
