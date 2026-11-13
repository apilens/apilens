package api

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
)

// RoleChecker answers several permission checks in one call; *authz.Client
// satisfies it.
type RoleChecker interface {
	CheckBulk(ctx context.Context, items []authz.CheckItem) ([]bool, error)
}

// roleChecks tell the project roles apart, highest first
// (authz/schema.zed): admin has manage_access, editor edit, viewer view.
var roleChecks = [...]struct {
	permission authz.Permission
	role       string
}{
	{authz.ProjectManageAccess, projects.RoleAdmin},
	{authz.ProjectEdit, projects.RoleEditor},
	{authz.ProjectView, projects.RoleViewer},
}

// maxBulkChecks bounds the items of one CheckBulk call (SpiceDB caps a bulk
// check request).
const maxBulkChecks = 300

// projectRoles returns user's effective role on each project as SpiceDB
// answers it: admin, editor, viewer, or "" when the user cannot view the
// project. An error wraps authz.ErrUnavailable when SpiceDB cannot answer;
// a nil checker answers authz.ErrUnavailable.
func projectRoles(ctx context.Context, c RoleChecker, user uuid.UUID, ps []projects.Project) ([]string, error) {
	out := make([]string, len(ps))
	if len(ps) == 0 {
		return out, nil
	}
	if c == nil {
		return nil, authz.ErrUnavailable
	}
	subject := authz.User(user.String())
	items := make([]authz.CheckItem, 0, len(ps)*len(roleChecks))
	for _, p := range ps {
		res := authz.Project(p.OrgID.String(), p.ID.String())
		for _, rc := range roleChecks {
			items = append(items, authz.CheckItem{Subject: subject, Permission: rc.permission, Resource: res})
		}
	}
	results := make([]bool, 0, len(items))
	for start := 0; start < len(items); start += maxBulkChecks {
		r, err := c.CheckBulk(ctx, items[start:min(start+maxBulkChecks, len(items))])
		if err != nil {
			return nil, err
		}
		results = append(results, r...)
	}
	for i := range ps {
		for j, rc := range roleChecks {
			if results[i*len(roleChecks)+j] {
				out[i] = rc.role
				break
			}
		}
	}
	return out, nil
}

// rolesProblem maps an error of projectRoles to a problem.
func rolesProblem(ctx context.Context, logger *slog.Logger, err error) error {
	if errors.Is(err, authz.ErrUnavailable) {
		return identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	}
	logger.ErrorContext(ctx, "project roles", "error", err)
	return identity.Err(identity.CodeInternal)
}

// authorizeProject checks permission for the signed-in user on the project
// slug with guard, with the rules of authz.Guard.Require: not_found (404)
// when the project does not exist or the user cannot view it, forbidden
// (403) when they can view it but lack permission, authz_unavailable (503)
// when SpiceDB cannot answer or guard is nil. It returns the project the
// guard resolved and the user.
func authorizeProject(ctx context.Context, guard ProjectAuthorizer, logger *slog.Logger, slug string, permission authz.Permission) (authz.Target, uuid.UUID, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return authz.Target{}, uuid.Nil, identity.Err(identity.CodeUnauthenticated)
	}
	if guard == nil {
		return authz.Target{}, uuid.Nil, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	}
	t, err := guard.AuthorizeProject(ctx, p, slug, permission)
	switch {
	case err == nil:
		return t, p.UserID, nil
	case errors.Is(err, authz.ErrNoResource):
		return t, uuid.Nil, identity.Err(identity.CodeNotFound)
	case errors.Is(err, authz.ErrForbidden):
		return t, uuid.Nil, identity.Err(identity.CodeForbidden)
	case errors.Is(err, authz.ErrUnavailable):
		return t, uuid.Nil, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	default:
		logger.ErrorContext(ctx, "authorize project", "error", err)
		return t, uuid.Nil, identity.Err(identity.CodeInternal)
	}
}
