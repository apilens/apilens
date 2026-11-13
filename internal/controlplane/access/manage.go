package access

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/notify"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// Default access values of a project (D2 in #753).
const (
	DefaultOrgRole = "org_role" // org members edit, org viewers view
	DefaultViewer  = "viewer"   // every org member views
	DefaultNone    = "none"     // only org owners and admins and direct grants
)

// DefaultMaxDirectMembers is the cap on direct grants per project when none
// is configured (access.max_direct_members_per_project).
const DefaultMaxDirectMembers = 500

var (
	// ErrNotOrgMember is returned when the target user is not a member of
	// the project's organization (or their account is deleted).
	ErrNotOrgMember = errors.New("access: not an organization member")
	// ErrMemberLimit is returned when the project already has as many
	// direct grants as it may (access.max_direct_members_per_project).
	ErrMemberLimit = errors.New("access: direct member limit reached")
)

// Auditor records audit events; *audit.Recorder satisfies it. Record must
// write in the transaction audit.WithTx puts in the context.
type Auditor interface {
	Record(ctx context.Context, e audit.Event) error
}

// Notifier emails project admins about sensitive changes;
// *notify.Notifier satisfies it.
type Notifier interface {
	ProjectAdmins(ctx context.Context, tx pgx.Tx, project uuid.UUID, ev notify.Event) (int, error)
}

// WithAudit makes the access writes record audit events through a.
func (s *Service) WithAudit(a Auditor) *Service {
	s.audit = a
	return s
}

// WithMaxDirectMembers caps the direct grants of a project; 0 disables the
// cap, a negative value keeps DefaultMaxDirectMembers.
func (s *Service) WithMaxDirectMembers(n int) *Service {
	if n >= 0 {
		s.maxMembers = n
	}
	return s
}

// WithNotifier makes a default access change email the project admins.
func (s *Service) WithNotifier(n Notifier) *Service {
	s.notifier = n
	return s
}

// ValidRole reports whether role is a project role.
func ValidRole(role string) bool { return rank(role) > 0 }

// ValidDefault reports whether d is a default access value.
func ValidDefault(d string) bool {
	return d == DefaultOrgRole || d == DefaultViewer || d == DefaultNone
}

// Get returns the access of one org member to project: their effective role
// and its sources. ErrNotFound when the project is gone or the person
// cannot view it.
func (s *Service) Get(ctx context.Context, project, user uuid.UUID) (Person, error) {
	return getPerson(ctx, db.New(s.pool), project, user)
}

// Grant gives target the direct role on project, or changes it, on behalf of
// actor (the caller has checked manage_access). target must be a member of
// the project's organization (ErrNotOrgMember). A role lower than what the
// person has through the organization is allowed: the returned Person says
// the effective role. In one transaction it emits project_member.upserted
// and audits project_member.added or project_member.role_changed; granting
// the role the person already has changes nothing.
func (s *Service) Grant(ctx context.Context, actor, project, target uuid.UUID, role string) (Person, error) {
	if !ValidRole(role) {
		return Person{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Person{}, fmt.Errorf("access: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, project)
	if err != nil {
		return Person{}, err
	}
	m, err := q.GetOrgMember(ctx, db.GetOrgMemberParams{OrgID: p.OrgID, UserID: target})
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, ErrNotOrgMember
	}
	if err != nil {
		return Person{}, fmt.Errorf("access: get member: %w", err)
	}
	prev, err := q.GetProjectMember(ctx, db.GetProjectMemberParams{ProjectID: project, UserID: target})
	existed := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Person{}, fmt.Errorf("access: get grant: %w", err)
	}
	if !existed || prev.Role != role {
		if !existed && s.maxMembers > 0 {
			n, err := q.CountProjectMembers(ctx, project)
			if err != nil {
				return Person{}, fmt.Errorf("access: count grants: %w", err)
			}
			if n >= int64(s.maxMembers) {
				return Person{}, ErrMemberLimit
			}
		}
		if _, err := q.UpsertProjectMember(ctx, db.UpsertProjectMemberParams{ProjectID: project, UserID: target, Role: role, AddedBy: &actor}); err != nil {
			return Person{}, fmt.Errorf("access: upsert grant: %w", err)
		}
		if err := outbox.Emit(ctx, tx, outbox.ProjectMemberUpserted, project,
			outbox.ProjectMemberUpsertedPayload{ProjectID: project, OrgID: p.OrgID, UserID: target, Role: role}); err != nil {
			return Person{}, err
		}
		ev := audit.Event{
			User: &target, Actor: &actor, Kind: audit.ProjectMemberAdded, Org: &p.OrgID, Project: &project,
			Target:  memberTarget(target, m.Email),
			Changes: &audit.Changes{Next: map[string]any{"role": role}},
			Meta:    map[string]any{"project_id": project.String(), "slug": p.Slug, "role": role},
		}
		if existed {
			ev.Kind = audit.ProjectMemberRoleChanged
			ev.Changes.Previous = map[string]any{"role": prev.Role}
			ev.Meta = map[string]any{"project_id": project.String(), "slug": p.Slug, "from": prev.Role, "to": role}
		}
		if err := s.record(ctx, tx, ev); err != nil {
			return Person{}, err
		}
	}
	person, err := getPerson(ctx, q, project, target)
	if err != nil {
		return Person{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Person{}, fmt.Errorf("access: commit: %w", err)
	}
	return person, nil
}

// Revoke removes target's direct grant on project on behalf of actor (the
// caller has checked manage_access; a caller may remove their own grant).
// It reports whether there was a grant. target must be a member of the
// project's organization (ErrNotOrgMember). In one transaction it emits
// project_member.deleted and audits project_member.removed.
func (s *Service) Revoke(ctx context.Context, actor, project, target uuid.UUID) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("access: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, project)
	if err != nil {
		return false, err
	}
	m, err := q.GetOrgMember(ctx, db.GetOrgMemberParams{OrgID: p.OrgID, UserID: target})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrNotOrgMember
	}
	if err != nil {
		return false, fmt.Errorf("access: get member: %w", err)
	}
	prev, err := q.GetProjectMember(ctx, db.GetProjectMemberParams{ProjectID: project, UserID: target})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("access: get grant: %w", err)
	}
	if _, err := q.DeleteProjectMember(ctx, db.DeleteProjectMemberParams{ProjectID: project, UserID: target}); err != nil {
		return false, fmt.Errorf("access: delete grant: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.ProjectMemberDeleted, project,
		outbox.ProjectMemberDeletedPayload{ProjectID: project, OrgID: p.OrgID, UserID: target}); err != nil {
		return false, err
	}
	if err := s.record(ctx, tx, audit.Event{
		User: &target, Actor: &actor, Kind: audit.ProjectMemberRemoved, Org: &p.OrgID, Project: &project,
		Target:  memberTarget(target, m.Email),
		Changes: &audit.Changes{Previous: map[string]any{"role": prev.Role}},
		Meta:    map[string]any{"project_id": project.String(), "slug": p.Slug, "role": prev.Role, "self": target == actor},
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("access: commit: %w", err)
	}
	return true, nil
}

// DefaultChange is the result of SetDefault.
type DefaultChange struct {
	Previous string // the default access before
	Current  string // the default access after (unchanged on a dry run)
	// LoseAccess is how many people lose access to the project with the
	// change: org members and viewers without a direct grant when the
	// default becomes none, 0 otherwise.
	LoseAccess int64
	DryRun     bool
}

// SetDefault sets project's default access for org members on behalf of
// actor (the caller has checked manage_access). With dryRun it only reports
// how many people would lose access and changes nothing. A change emits
// project.access_changed, audits project.access_changed and emails the
// project admins, in one transaction; setting the current value changes
// nothing.
func (s *Service) SetDefault(ctx context.Context, actor, project uuid.UUID, def string, dryRun bool) (DefaultChange, error) {
	if !ValidDefault(def) {
		return DefaultChange{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DefaultChange{}, fmt.Errorf("access: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	p, err := lockProject(ctx, q, project)
	if err != nil {
		return DefaultChange{}, err
	}
	out := DefaultChange{Previous: p.DefaultAccess, Current: def, DryRun: dryRun}
	if def == DefaultNone && p.DefaultAccess != DefaultNone {
		if out.LoseAccess, err = q.CountProjectDefaultOnlyAccess(ctx, project); err != nil {
			return DefaultChange{}, fmt.Errorf("access: count: %w", err)
		}
	}
	if dryRun {
		out.Current = p.DefaultAccess
		return out, nil
	}
	if def == p.DefaultAccess {
		return out, nil
	}
	if _, err := q.SetProjectDefaultAccess(ctx, db.SetProjectDefaultAccessParams{ID: project, DefaultAccess: def}); err != nil {
		return DefaultChange{}, fmt.Errorf("access: set default: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.ProjectAccessChanged, project,
		outbox.ProjectAccessChangedPayload{ProjectID: project, OrgID: p.OrgID, DefaultAccess: def}); err != nil {
		return DefaultChange{}, err
	}
	if err := s.record(ctx, tx, audit.Event{
		Actor: &actor, Kind: audit.ProjectAccessChanged, Org: &p.OrgID, Project: &project,
		Target:  audit.Target{Type: "project", ID: project.String(), Label: p.Slug},
		Changes: &audit.Changes{Previous: map[string]any{"default_access": p.DefaultAccess}, Next: map[string]any{"default_access": def}},
		Meta:    map[string]any{"project_id": project.String(), "slug": p.Slug, "from": p.DefaultAccess, "to": def, "lose_access": out.LoseAccess},
	}); err != nil {
		return DefaultChange{}, err
	}
	if s.notifier != nil {
		if _, err := s.notifier.ProjectAdmins(ctx, tx, project, notify.Event{Change: notify.DefaultAccessChanged, Actor: actor, Detail: def}); err != nil {
			return DefaultChange{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return DefaultChange{}, fmt.Errorf("access: commit: %w", err)
	}
	return out, nil
}

func (s *Service) record(ctx context.Context, tx pgx.Tx, e audit.Event) error {
	if s.audit == nil {
		return nil
	}
	return s.audit.Record(audit.WithTx(ctx, tx), e)
}

func lockProject(ctx context.Context, q *db.Queries, project uuid.UUID) (db.LockProjectAccessRow, error) {
	p, err := q.LockProjectAccess(ctx, project)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, fmt.Errorf("access: lock project: %w", err)
	}
	return p, nil
}

// getPerson is Get inside the write's transaction.
func getPerson(ctx context.Context, q *db.Queries, project, user uuid.UUID) (Person, error) {
	rows, err := q.ListProjectAccess(ctx, db.ListProjectAccessParams{ProjectID: project, UserID: &user, RowLimit: 1})
	if err != nil {
		return Person{}, fmt.Errorf("access: get: %w", err)
	}
	if len(rows) == 0 {
		return Person{}, ErrNotFound
	}
	return toPerson(rows[0]), nil
}

// memberTarget is the audit target of a project grant: the user, labelled
// with their email.
func memberTarget(user uuid.UUID, email string) audit.Target {
	return audit.Target{Type: "project_member", ID: user.String(), Label: email}
}
