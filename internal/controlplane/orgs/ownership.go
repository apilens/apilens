package orgs

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Ownership answers the account service's last-owner question (#276): which
// organizations would lose their only owner if a user's account went away.
type Ownership struct {
	q *db.Queries
}

// NewOwnership returns the check over q.
func NewOwnership(q db.DBTX) *Ownership {
	return &Ownership{q: db.New(q)}
}

// SoleOwnedOrgs returns the active organizations user is the only live owner
// of; account deletion waits for an ownership transfer while any remain.
func (o *Ownership) SoleOwnedOrgs(ctx context.Context, user uuid.UUID) ([]uuid.UUID, error) {
	orgs, err := o.q.SoleOwnedOrganizations(ctx, user)
	if err != nil {
		return nil, fmt.Errorf("orgs: sole owned organizations: %w", err)
	}
	return orgs, nil
}
