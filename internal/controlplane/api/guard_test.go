package api

import (
	"context"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
)

// allowChecker grants every permission.
type allowChecker struct{}

func (allowChecker) Check(context.Context, authz.Object, authz.Permission, authz.Resource) (bool, error) {
	return true, nil
}

// anyResolver resolves every slug to a fresh id.
type anyResolver struct{}

func (anyResolver) OrgID(context.Context, string) (uuid.UUID, error) { return uuid.New(), nil }

func (anyResolver) Project(context.Context, string) (uuid.UUID, uuid.UUID, error) {
	return uuid.New(), uuid.New(), nil
}

// allowAll is a Guard that lets every signed-in caller through, for tests of
// the handlers behind it.
func allowAll() *authz.Guard {
	return authz.NewGuard(allowChecker{}, anyResolver{}, authz.GuardOptions{}, nil)
}
