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

// Paths of the organization member endpoints.
const (
	MembersPath           = OrgPath + "/members"
	MemberPath            = MembersPath + "/{user_id}"
	LeaveOrgPath          = OrgPath + "/leave"
	TransferOwnershipPath = OrgPath + "/transfer-ownership"
)

// MemberService lists and manages organization members; *orgs.Service
// satisfies it.
type MemberService interface {
	Members(ctx context.Context, user uuid.UUID, slug string) ([]orgs.Member, error)
	ChangeRole(ctx context.Context, user uuid.UUID, slug string, target uuid.UUID, role string) (orgs.Member, error)
	RemoveMember(ctx context.Context, user uuid.UUID, slug string, target uuid.UUID) error
	Leave(ctx context.Context, user uuid.UUID, slug string) error
	TransferOwnership(ctx context.Context, user uuid.UUID, slug string, target uuid.UUID) error
}

// MemberUser is the user of an organization member.
type MemberUser struct {
	ID        string `json:"id" format:"uuid"`
	Email     string `json:"email" format:"email"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// Member is a member of an organization.
type Member struct {
	User        MemberUser `json:"user"`
	Role        string     `json:"role" enum:"owner,admin,member,viewer"`
	JoinedAt    time.Time  `json:"joined_at" doc:"When the user became a member."`
	LastLoginAt *time.Time `json:"last_login_at" required:"true" nullable:"true" doc:"When the user last signed in; null if never."`
}

// ListMembersOutput is the response of GET /api/v1/orgs/{slug}/members.
type ListMembersOutput struct {
	Body []Member
}

// MemberInput names an organization member in the path.
type MemberInput struct {
	OrgSlugInput
	UserID string `path:"user_id" format:"uuid" doc:"The member's user id."`
}

// ChangeRoleInput is the request of PATCH /api/v1/orgs/{slug}/members/{user_id}.
type ChangeRoleInput struct {
	MemberInput
	Body struct {
		Role string `json:"role" enum:"owner,admin,member,viewer" doc:"The new role."`
	}
}

// MemberOutput is the response of PATCH /api/v1/orgs/{slug}/members/{user_id}.
type MemberOutput struct {
	Body Member
}

// TransferOwnershipInput is the request of POST
// /api/v1/orgs/{slug}/transfer-ownership.
type TransferOwnershipInput struct {
	OrgSlugInput
	Body struct {
		UserID string `json:"user_id" format:"uuid" doc:"The member who becomes an owner."`
	}
}

// Members serves the organization member endpoints.
type Members struct {
	svc    MemberService
	logger *slog.Logger
}

// NewMembers returns the organization member endpoints over svc.
func NewMembers(svc MemberService, logger *slog.Logger) *Members {
	return &Members{svc: svc, logger: logger}
}

// Register mounts the member operations. They declare the session scheme,
// so authn.Middleware must be installed on api before.
func (m *Members) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-org-members",
		Method:      http.MethodGet,
		Path:        MembersPath,
		Summary:     "List organization members",
		Description: "Lists the members of the organization with their user, role, when they joined and when they last signed in, oldest member first. Any member may list them; 403 `forbidden` for an organization the user is not a member of.",
		Tags:        []string{server.TagOrganizations},
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), m.list)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "change-org-member-role",
		Method:      http.MethodPatch,
		Path:        MemberPath,
		Summary:     "Change a member's role",
		Description: "Sets the member's role. Owners and admins only; only owners can make someone an owner or change an owner's role (403 `forbidden`). " +
			"Demoting the last owner answers `last_owner`; a user who is not a member answers `member_gone`. Audited as `member.role_changed`.",
		Tags:     []string{server.TagOrganizations},
		Security: security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeMemberGone, identity.CodeLastOwner, identity.CodeInternal), m.changeRole)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "remove-org-member",
		Method:        http.MethodDelete,
		Path:          MemberPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Remove a member",
		Description: "Removes the member from the organization. Owners and admins only; only owners can remove an owner (403 `forbidden`). " +
			"Removing the last owner answers `last_owner`; a user who is not a member answers `member_gone`. Audited as `member.removed`.",
		Tags:     []string{server.TagOrganizations},
		Security: security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeMemberGone, identity.CodeLastOwner, identity.CodeInternal), m.remove)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "leave-org",
		Method:        http.MethodPost,
		Path:          LeaveOrgPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Leave an organization",
		Description:   "Removes the signed-in user from the organization. The last owner cannot leave (`last_owner`): transfer ownership or delete the organization first. Audited as `member.removed`.",
		Tags:          []string{server.TagOrganizations},
		Security:      security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeLastOwner, identity.CodeInternal), m.leave)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "transfer-org-ownership",
		Method:        http.MethodPost,
		Path:          TransferOwnershipPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Transfer ownership",
		Description: "Makes the member an owner and the signed-in owner an admin, in one step. Owners only (403 `forbidden`). " +
			"A user who is not a member answers `member_gone`; transferring to oneself answers `invalid_request`. Audited as `member.role_changed` for each member whose role changes.",
		Tags:     []string{server.TagOrganizations},
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeMemberGone, identity.CodeInternal), m.transfer)
}

// problem maps an error of a member operation to a problem.
func (m *Members) problem(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, orgs.ErrNotFound), errors.Is(err, orgs.ErrForbidden):
		return identity.Err(identity.CodeForbidden)
	case errors.Is(err, orgs.ErrMemberNotFound):
		return identity.Err(identity.CodeMemberGone)
	case errors.Is(err, orgs.ErrLastOwner):
		return identity.Err(identity.CodeLastOwner)
	case errors.Is(err, orgs.ErrInvalid):
		return identity.Err(identity.CodeInvalidRequest)
	default:
		m.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func toMember(o orgs.Member) Member {
	var last *time.Time
	if o.LastLoginAt != nil {
		t := o.LastLoginAt.UTC()
		last = &t
	}
	return Member{
		User:        MemberUser{ID: o.UserID.String(), Email: o.Email, Name: o.Name, AvatarURL: o.AvatarURL},
		Role:        o.Role,
		JoinedAt:    o.JoinedAt.UTC(),
		LastLoginAt: last,
	}
}

func (m *Members) list(ctx context.Context, in *OrgSlugInput) (*ListMembersOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	list, err := m.svc.Members(ctx, uid, in.Slug)
	if err != nil {
		return nil, m.problem(ctx, "list members", err)
	}
	out := &ListMembersOutput{Body: make([]Member, 0, len(list))}
	for _, o := range list {
		out.Body = append(out.Body, toMember(o))
	}
	return out, nil
}

func (m *Members) changeRole(ctx context.Context, in *ChangeRoleInput) (*MemberOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	target, err := uuid.Parse(in.UserID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	o, err := m.svc.ChangeRole(ctx, uid, in.Slug, target, in.Body.Role)
	if err != nil {
		return nil, m.problem(ctx, "change member role", err)
	}
	return &MemberOutput{Body: toMember(o)}, nil
}

func (m *Members) remove(ctx context.Context, in *MemberInput) (*struct{}, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	target, err := uuid.Parse(in.UserID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	if err := m.svc.RemoveMember(ctx, uid, in.Slug, target); err != nil {
		return nil, m.problem(ctx, "remove member", err)
	}
	return nil, nil
}

func (m *Members) leave(ctx context.Context, in *OrgSlugInput) (*struct{}, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	if err := m.svc.Leave(ctx, uid, in.Slug); err != nil {
		return nil, m.problem(ctx, "leave organization", err)
	}
	return nil, nil
}

func (m *Members) transfer(ctx context.Context, in *TransferOwnershipInput) (*struct{}, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	target, err := uuid.Parse(in.Body.UserID)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	if err := m.svc.TransferOwnership(ctx, uid, in.Slug, target); err != nil {
		return nil, m.problem(ctx, "transfer ownership", err)
	}
	return nil, nil
}
