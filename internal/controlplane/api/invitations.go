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
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the organization invitation endpoints.
const (
	InvitationsPath      = OrgPath + "/invitations"
	InvitationPath       = InvitationsPath + "/{id}"
	ResendInvitationPath = InvitationPath + "/resend"
)

// InvitationService creates, lists, resends and revokes invitations;
// *orgs.InvitationService satisfies it.
type InvitationService interface {
	Invite(ctx context.Context, user uuid.UUID, slug string, invites []orgs.Invite) ([]orgs.InviteResult, error)
	Pending(ctx context.Context, user uuid.UUID, slug string) ([]orgs.Invitation, error)
	Resend(ctx context.Context, user uuid.UUID, slug string, id uuid.UUID) (orgs.Invitation, error)
	Revoke(ctx context.Context, user uuid.UUID, slug string, id uuid.UUID) error
}

// Inviter is the user who sent an invitation.
type Inviter struct {
	ID    string `json:"id" format:"uuid"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// Invitation is a pending invitation to an organization.
type Invitation struct {
	ID        string     `json:"id" format:"uuid"`
	Email     string     `json:"email" format:"email"`
	Role      string     `json:"role" enum:"admin,member,viewer"`
	InvitedBy *Inviter   `json:"invited_by,omitempty" doc:"Who sent the invitation; absent once their account is gone."`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt time.Time  `json:"expires_at" doc:"When the emailed link stops working. A pending invitation past it can still be resent."`
	ResentAt  *time.Time `json:"resent_at" required:"true" nullable:"true" doc:"When the invitation was last resent; null if never."`
}

// InviteEntry is one address to invite.
type InviteEntry struct {
	Email string `json:"email" format:"email" maxLength:"320" doc:"The address to invite."`
	Role  string `json:"role" enum:"admin,member,viewer" doc:"The role the invitee joins with."`
}

// CreateInvitationsInput is the request of POST /api/v1/orgs/{slug}/invitations.
type CreateInvitationsInput struct {
	OrgSlugInput
	Body struct {
		Invites []InviteEntry `json:"invites" minItems:"1" maxItems:"50" doc:"The addresses to invite, at most 50."`
	}
}

// InviteResult is the outcome for one address.
type InviteResult struct {
	Email      string      `json:"email"`
	Status     string      `json:"status" enum:"invited,replaced,already_member,duplicate" doc:"invited: a new invitation was emailed; replaced: a pending invitation was replaced by a new one and emailed; already_member: the address belongs to a member, nothing sent; duplicate: the address appeared earlier in the request."`
	Invitation *Invitation `json:"invitation,omitempty" doc:"The invitation, when one was emailed (invited, replaced)."`
}

// CreateInvitationsOutput is the response of POST
// /api/v1/orgs/{slug}/invitations.
type CreateInvitationsOutput struct {
	Body struct {
		Results []InviteResult `json:"results" doc:"One result per requested address, in request order."`
	}
}

// ListInvitationsOutput is the response of GET
// /api/v1/orgs/{slug}/invitations.
type ListInvitationsOutput struct {
	Body []Invitation
}

// InvitationInput names an invitation in the path.
type InvitationInput struct {
	OrgSlugInput
	ID string `path:"id" format:"uuid" doc:"The invitation id."`
}

// InvitationOutput is the response of POST
// /api/v1/orgs/{slug}/invitations/{id}/resend.
type InvitationOutput struct {
	Body Invitation
}

// Invitations serves the organization invitation endpoints.
type Invitations struct {
	svc    InvitationService
	logger *slog.Logger
}

// NewInvitations returns the organization invitation endpoints over svc.
func NewInvitations(svc InvitationService, logger *slog.Logger) *Invitations {
	return &Invitations{svc: svc, logger: logger}
}

// Register mounts the invitation operations. They declare the session
// scheme, so authn.Middleware must be installed on api before.
func (h *Invitations) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "create-org-invitations",
		Method:      http.MethodPost,
		Path:        InvitationsPath,
		Summary:     "Invite people to an organization",
		Description: "Invites up to 50 addresses, each with the admin, member or viewer role, and emails each a link to `/invite/{token}` that works for 7 days. " +
			"Owners and admins only (403 `forbidden`). Addresses of members are skipped (`already_member`); an address with a pending invitation gets a new one in its place (`replaced`). " +
			"Returns one result per address, in request order. Each email sent is audited as `invitation.sent`.",
		Tags:     []string{server.TagOrganizations},
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), h.create)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-org-invitations",
		Method:      http.MethodGet,
		Path:        InvitationsPath,
		Summary:     "List pending invitations",
		Description: "Lists the organization's pending invitations, newest first, including expired ones that can still be resent. Owners and admins only (403 `forbidden`).",
		Tags:        []string{server.TagOrganizations},
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), h.list)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "resend-org-invitation",
		Method:      http.MethodPost,
		Path:        ResendInvitationPath,
		Summary:     "Resend an invitation",
		Description: "Emails the pending invitation again with a new link that works for 7 days; the previous link stops working. Owners and admins only (403 `forbidden`). " +
			"An invitation can be emailed at most once every 5 minutes (`rate_limited` with `retry_after`). An invitation that was accepted or revoked answers `invite_expired`. Audited as `invitation.sent`.",
		Tags:     []string{server.TagOrganizations},
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInviteExpired, identity.CodeRateLimited, identity.CodeInternal), h.resend)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "revoke-org-invitation",
		Method:        http.MethodDelete,
		Path:          InvitationPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Revoke an invitation",
		Description:   "Revokes the pending invitation; its link stops working. Owners and admins only (403 `forbidden`). An invitation that was accepted or already revoked answers `invite_expired`.",
		Tags:          []string{server.TagOrganizations},
		Security:      security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInviteExpired, identity.CodeInternal), h.revoke)
}

// problem maps an error of an invitation operation to a problem.
func (h *Invitations) problem(ctx context.Context, op string, err error) error {
	var cooldown *orgs.ResendCooldownError
	switch {
	case errors.Is(err, orgs.ErrNotFound), errors.Is(err, orgs.ErrForbidden), errors.Is(err, orgs.ErrMemberNotFound):
		return identity.Err(identity.CodeForbidden)
	case errors.Is(err, orgs.ErrInvitationNotFound):
		return identity.Err(identity.CodeInviteExpired)
	case errors.As(err, &cooldown):
		return identity.ErrRetryAfter(identity.CodeRateLimited, cooldown.RetryAfter)
	case errors.Is(err, orgs.ErrInvalid):
		return identity.Err(identity.CodeInvalidRequest)
	default:
		h.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func toInvitation(o orgs.Invitation) Invitation {
	var by *Inviter
	if o.InvitedBy != nil && o.InviterEmail != "" {
		by = &Inviter{ID: o.InvitedBy.String(), Email: o.InviterEmail, Name: o.InviterName}
	}
	var resent *time.Time
	if o.ResentAt != nil {
		t := o.ResentAt.UTC()
		resent = &t
	}
	return Invitation{
		ID:        o.ID.String(),
		Email:     o.Email,
		Role:      o.Role,
		InvitedBy: by,
		CreatedAt: o.CreatedAt.UTC(),
		ExpiresAt: o.ExpiresAt.UTC(),
		ResentAt:  resent,
	}
}

func (h *Invitations) create(ctx context.Context, in *CreateInvitationsInput) (*CreateInvitationsOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	invites := make([]orgs.Invite, 0, len(in.Body.Invites))
	for _, e := range in.Body.Invites {
		invites = append(invites, orgs.Invite{Email: e.Email, Role: e.Role})
	}
	results, err := h.svc.Invite(ctx, uid, in.Slug, invites)
	if err != nil {
		return nil, h.problem(ctx, "create invitations", err)
	}
	out := &CreateInvitationsOutput{}
	out.Body.Results = make([]InviteResult, 0, len(results))
	for _, r := range results {
		res := InviteResult{Email: r.Email, Status: r.Status}
		if r.Invitation != nil {
			inv := toInvitation(*r.Invitation)
			res.Invitation = &inv
		}
		out.Body.Results = append(out.Body.Results, res)
	}
	return out, nil
}

func (h *Invitations) list(ctx context.Context, in *OrgSlugInput) (*ListInvitationsOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	list, err := h.svc.Pending(ctx, uid, in.Slug)
	if err != nil {
		return nil, h.problem(ctx, "list invitations", err)
	}
	out := &ListInvitationsOutput{Body: make([]Invitation, 0, len(list))}
	for _, o := range list {
		out.Body = append(out.Body, toInvitation(o))
	}
	return out, nil
}

func (h *Invitations) resend(ctx context.Context, in *InvitationInput) (*InvitationOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	o, err := h.svc.Resend(ctx, uid, in.Slug, id)
	if err != nil {
		return nil, h.problem(ctx, "resend invitation", err)
	}
	return &InvitationOutput{Body: toInvitation(o)}, nil
}

func (h *Invitations) revoke(ctx context.Context, in *InvitationInput) (*struct{}, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	if err := h.svc.Revoke(ctx, uid, in.Slug, id); err != nil {
		return nil, h.problem(ctx, "revoke invitation", err)
	}
	return nil, nil
}
