// Package outbox writes transactional outbox rows (ADR 0006).
//
// Every write that changes who can see what (organizations, memberships,
// projects) calls Emit with the same pgx.Tx as the change, so the outbox row
// commits or rolls back with it. The relay (#291) later translates each row
// into SpiceDB relationship updates. Topics and payloads are a stable
// contract, documented in docs/architecture/identity.md: payloads carry ids
// and roles only, never emails or secrets, and a new shape gets a new topic.
package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Topic names the kind of change an outbox row describes.
type Topic string

const (
	OrgCreated         Topic = "org.created"
	OrgDeleted         Topic = "org.deleted"
	MembershipUpserted Topic = "membership.upserted"
	MembershipDeleted  Topic = "membership.deleted"
	ProjectCreated     Topic = "project.created"
	ProjectDeleted     Topic = "project.deleted"
	ProjectMoved       Topic = "project.moved"

	ProjectMemberUpserted Topic = "project_member.upserted"
	ProjectMemberDeleted  Topic = "project_member.deleted"
	ProjectAccessChanged  Topic = "project.access_changed"
	ProjectRestored       Topic = "project.restored"
)

// Topics lists every topic, in documentation order.
var Topics = []Topic{
	OrgCreated, OrgDeleted, MembershipUpserted, MembershipDeleted, ProjectCreated, ProjectDeleted, ProjectMoved,
	ProjectMemberUpserted, ProjectMemberDeleted, ProjectAccessChanged, ProjectRestored,
}

// Payload is one of the payload types below. The set is closed: each payload
// type belongs to exactly one topic and knows its aggregate id.
type Payload interface {
	topic() Topic
	aggregateID() uuid.UUID
}

// OrgCreatedPayload is the payload of OrgCreated; aggregate_id is the org id.
type OrgCreatedPayload struct {
	OrgID       uuid.UUID `json:"org_id"`
	OwnerUserID uuid.UUID `json:"owner_user_id"`
}

// OrgDeletedPayload is the payload of OrgDeleted; aggregate_id is the org id.
type OrgDeletedPayload struct {
	OrgID uuid.UUID `json:"org_id"`
}

// MembershipUpsertedPayload is the payload of MembershipUpserted (a member
// added or their role changed); aggregate_id is the org id.
type MembershipUpsertedPayload struct {
	OrgID  uuid.UUID `json:"org_id"`
	UserID uuid.UUID `json:"user_id"`
	Role   string    `json:"role"`
}

// MembershipDeletedPayload is the payload of MembershipDeleted; aggregate_id
// is the org id.
type MembershipDeletedPayload struct {
	OrgID  uuid.UUID `json:"org_id"`
	UserID uuid.UUID `json:"user_id"`
}

// ProjectCreatedPayload is the payload of ProjectCreated; aggregate_id is the
// project id.
type ProjectCreatedPayload struct {
	ProjectID uuid.UUID `json:"project_id"`
	OrgID     uuid.UUID `json:"org_id"`
}

// ProjectDeletedPayload is the payload of ProjectDeleted; aggregate_id is the
// project id.
type ProjectDeletedPayload struct {
	ProjectID uuid.UUID `json:"project_id"`
}

// ProjectMovedPayload is the payload of ProjectMoved; aggregate_id is the
// project id.
type ProjectMovedPayload struct {
	ProjectID uuid.UUID `json:"project_id"`
	FromOrgID uuid.UUID `json:"from_org_id"`
	ToOrgID   uuid.UUID `json:"to_org_id"`
}

// ProjectMemberUpsertedPayload is the payload of ProjectMemberUpserted (a
// direct project role granted or changed); aggregate_id is the project id.
// Role is admin, editor or viewer.
type ProjectMemberUpsertedPayload struct {
	ProjectID uuid.UUID `json:"project_id"`
	OrgID     uuid.UUID `json:"org_id"`
	UserID    uuid.UUID `json:"user_id"`
	Role      string    `json:"role"`
}

// ProjectMemberDeletedPayload is the payload of ProjectMemberDeleted (a
// direct project role removed, also once per grant when the person leaves
// the organization); aggregate_id is the project id.
type ProjectMemberDeletedPayload struct {
	ProjectID uuid.UUID `json:"project_id"`
	OrgID     uuid.UUID `json:"org_id"`
	UserID    uuid.UUID `json:"user_id"`
}

// ProjectAccessChangedPayload is the payload of ProjectAccessChanged (the
// project's default access for org members changed); aggregate_id is the
// project id. DefaultAccess is org_role, viewer or none.
type ProjectAccessChangedPayload struct {
	ProjectID     uuid.UUID `json:"project_id"`
	OrgID         uuid.UUID `json:"org_id"`
	DefaultAccess string    `json:"default_access"`
}

// ProjectRestoredPayload is the payload of ProjectRestored (a deleted
// project restored before its purge); aggregate_id is the project id. It
// carries what project.deleted removed, read from Postgres at restore time:
// the default access (org_role, viewer or none) and every direct grant.
type ProjectRestoredPayload struct {
	ProjectID     uuid.UUID            `json:"project_id"`
	OrgID         uuid.UUID            `json:"org_id"`
	DefaultAccess string               `json:"default_access"`
	Members       []ProjectMemberGrant `json:"members"`
}

// ProjectMemberGrant is one direct project role in ProjectRestoredPayload.
type ProjectMemberGrant struct {
	UserID uuid.UUID `json:"user_id"`
	Role   string    `json:"role"`
}

func (ProjectRestoredPayload) topic() Topic             { return ProjectRestored }
func (p ProjectRestoredPayload) aggregateID() uuid.UUID { return p.ProjectID }

func (ProjectMemberUpsertedPayload) topic() Topic             { return ProjectMemberUpserted }
func (ProjectMemberDeletedPayload) topic() Topic              { return ProjectMemberDeleted }
func (ProjectAccessChangedPayload) topic() Topic              { return ProjectAccessChanged }
func (p ProjectMemberUpsertedPayload) aggregateID() uuid.UUID { return p.ProjectID }
func (p ProjectMemberDeletedPayload) aggregateID() uuid.UUID  { return p.ProjectID }
func (p ProjectAccessChangedPayload) aggregateID() uuid.UUID  { return p.ProjectID }

func (OrgCreatedPayload) topic() Topic                     { return OrgCreated }
func (OrgDeletedPayload) topic() Topic                     { return OrgDeleted }
func (MembershipUpsertedPayload) topic() Topic             { return MembershipUpserted }
func (MembershipDeletedPayload) topic() Topic              { return MembershipDeleted }
func (ProjectCreatedPayload) topic() Topic                 { return ProjectCreated }
func (ProjectDeletedPayload) topic() Topic                 { return ProjectDeleted }
func (ProjectMovedPayload) topic() Topic                   { return ProjectMoved }
func (p OrgCreatedPayload) aggregateID() uuid.UUID         { return p.OrgID }
func (p OrgDeletedPayload) aggregateID() uuid.UUID         { return p.OrgID }
func (p MembershipUpsertedPayload) aggregateID() uuid.UUID { return p.OrgID }
func (p MembershipDeletedPayload) aggregateID() uuid.UUID  { return p.OrgID }
func (p ProjectCreatedPayload) aggregateID() uuid.UUID     { return p.ProjectID }
func (p ProjectDeletedPayload) aggregateID() uuid.UUID     { return p.ProjectID }
func (p ProjectMovedPayload) aggregateID() uuid.UUID       { return p.ProjectID }

// ErrInvalid is returned (wrapped) when topic, aggregate id and payload do not
// agree; nothing is written.
var ErrInvalid = errors.New("outbox: invalid event")

// Emit writes one outbox row inside tx and wakes the relay when tx commits.
// topic must be the payload's topic and aggregateID its aggregate id (the org
// id for org and membership topics, the project id for project and
// project_member topics). If
// tx rolls back, neither the row nor the wake-up survives.
func Emit(ctx context.Context, tx pgx.Tx, topic Topic, aggregateID uuid.UUID, payload Payload) error {
	if err := validate(topic, aggregateID, payload); err != nil {
		return err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("outbox: encode %s payload: %w", topic, err)
	}
	q := db.New(tx)
	if _, err := q.InsertOutbox(ctx, db.InsertOutboxParams{Topic: string(topic), AggregateID: aggregateID.String(), Payload: body}); err != nil {
		return fmt.Errorf("outbox: insert %s: %w", topic, err)
	}
	if err := q.NotifyOutbox(ctx); err != nil {
		return fmt.Errorf("outbox: notify %s: %w", topic, err)
	}
	return nil
}

func validate(topic Topic, aggregateID uuid.UUID, payload Payload) error {
	if payload == nil {
		return fmt.Errorf("%w: %s has no payload", ErrInvalid, topic)
	}
	if payload.topic() != topic {
		return fmt.Errorf("%w: %T is the payload of %s, not %s", ErrInvalid, payload, payload.topic(), topic)
	}
	if aggregateID == uuid.Nil {
		return fmt.Errorf("%w: %s has no aggregate id", ErrInvalid, topic)
	}
	if payload.aggregateID() != aggregateID {
		return fmt.Errorf("%w: %s aggregate id %s does not match payload id %s", ErrInvalid, topic, aggregateID, payload.aggregateID())
	}
	return nil
}
