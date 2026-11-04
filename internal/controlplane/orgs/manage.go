package orgs

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/identity/audit"
)

// RoleAdmin is the membership role that, like owner, may change an
// organization's settings.
const RoleAdmin = "admin"

// MaxAllowedDomains bounds organizations.allowed_domains.
const MaxAllowedDomains = 50

// Errors returned by the read, update and delete operations of Service.
var (
	// ErrNotFound: no active organization has the slug, or the user is not a
	// member of it. The two are deliberately indistinguishable.
	ErrNotFound = errors.New("orgs: organization not found")
	// ErrForbidden: the user is a member but their role does not allow the
	// change.
	ErrForbidden = errors.New("orgs: forbidden")
	// ErrSlugImmutable: the update asks for a different slug. Renaming a
	// slug (with a redirect from the old one) is not supported yet.
	ErrSlugImmutable = errors.New("orgs: slug cannot be changed")
)

// DomainNotAllowedError is returned by Update when an allowed domain is a
// public email provider anyone can hold an address at.
type DomainNotAllowedError struct {
	Domain string
}

func (e *DomainNotAllowedError) Error() string {
	return "orgs: domain not allowed: " + e.Domain
}

// Summary is an organization in the list of a user's organizations.
type Summary struct {
	Org
	ProjectCount int64
	MemberCount  int64
}

// Detail is an organization with its settings, as seen by a member.
type Detail struct {
	Org
	AllowedDomains []string
	DomainJoin     bool
}

// Update is a partial update of an organization; nil fields are left
// unchanged.
type Update struct {
	Name           *string
	Slug           *string
	AllowedDomains *[]string
	DomainJoin     *bool
}

// hostnameRE is a lower-case DNS hostname with at least two labels: labels of
// letters, digits and inner hyphens, at most 63 characters each, and a
// top-level label that is not all digits.
var hostnameRE = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)

// ValidDomain reports whether domain is a lower-case hostname that an
// organization could own (at most 253 characters, at least two labels).
func ValidDomain(domain string) bool {
	return len(domain) <= 253 && hostnameRE.MatchString(domain)
}

// CanManage reports whether role may change an organization's settings.
func CanManage(role string) bool { return role == RoleOwner || role == RoleAdmin }

// List returns the active organizations user belongs to, with their role and
// counts of projects and members.
func (s *Service) List(ctx context.Context, user uuid.UUID) ([]Summary, error) {
	rows, err := db.New(s.pool).ListUserOrganizationsWithCounts(ctx, user)
	if err != nil {
		return nil, fmt.Errorf("orgs: list: %w", err)
	}
	out := make([]Summary, 0, len(rows))
	for _, r := range rows {
		out = append(out, Summary{
			Org:          Org{ID: r.ID, Slug: r.Slug, Name: r.Name, Role: r.Role, CreatedAt: r.CreatedAt},
			ProjectCount: r.ProjectCount,
			MemberCount:  r.MemberCount,
		})
	}
	return out, nil
}

// Get returns the active organization slug as seen by user, who must be a
// member (ErrNotFound otherwise).
func (s *Service) Get(ctx context.Context, user uuid.UUID, slug string) (Detail, error) {
	r, err := db.New(s.pool).GetMemberOrganization(ctx, db.GetMemberOrganizationParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return Detail{}, ErrNotFound
	}
	if err != nil {
		return Detail{}, fmt.Errorf("orgs: get: %w", err)
	}
	return detail(db.LockMemberOrganizationRow(r)), nil
}

// Update applies u to the organization slug on behalf of user, who must be
// an owner or admin. The name is trimmed; allowed domains are deduplicated
// and must be lower-case hostnames that are not public email providers. A
// slug different from the current one is ErrSlugImmutable. The change is
// audited as org.updated.
func (s *Service) Update(ctx context.Context, user uuid.UUID, slug string, u Update) (Detail, error) {
	params, err := s.validate(u)
	if err != nil {
		return Detail{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Detail{}, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := lockMember(ctx, q, user, slug)
	if err != nil {
		return Detail{}, err
	}
	if !CanManage(cur.Role) {
		return Detail{}, ErrForbidden
	}
	if u.Slug != nil && *u.Slug != cur.Slug {
		return Detail{}, ErrSlugImmutable
	}
	params.ID = cur.ID
	o, err := q.UpdateOrganization(ctx, params)
	if err != nil {
		return Detail{}, fmt.Errorf("orgs: update: %w", err)
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.OrgUpdated,
		Meta:  map[string]any{"org_id": o.ID.String(), "slug": o.Slug, "fields": changed(u)},
	}); err != nil {
		return Detail{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Detail{}, fmt.Errorf("orgs: commit: %w", err)
	}
	return detail(db.LockMemberOrganizationRow{
		ID: o.ID, Slug: o.Slug, Name: o.Name, CreatedAt: o.CreatedAt,
		AllowedDomains: o.AllowedDomains, DomainJoin: o.DomainJoin, Role: cur.Role,
	}), nil
}

// Delete soft-deletes the organization slug on behalf of user, who must be
// an owner. In the same transaction it emits the org.deleted outbox row (the
// relay then drops the organization's relationships from SpiceDB) and
// audits org.deleted. The slug becomes free for a new organization.
func (s *Service) Delete(ctx context.Context, user uuid.UUID, slug string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := lockMember(ctx, q, user, slug)
	if err != nil {
		return err
	}
	if cur.Role != RoleOwner {
		return ErrForbidden
	}
	if _, err := q.SoftDeleteOrganization(ctx, cur.ID); err != nil {
		return fmt.Errorf("orgs: delete: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.OrgDeleted, cur.ID, outbox.OrgDeletedPayload{OrgID: cur.ID}); err != nil {
		return err
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.OrgDeleted,
		Meta:  map[string]any{"org_id": cur.ID.String(), "slug": cur.Slug},
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("orgs: commit: %w", err)
	}
	return nil
}

// validate checks u and turns it into UpdateOrganization parameters (ID
// unset).
func (s *Service) validate(u Update) (db.UpdateOrganizationParams, error) {
	var p db.UpdateOrganizationParams
	if u.Name != nil {
		name := strings.TrimSpace(*u.Name)
		if name == "" {
			return p, ErrInvalid
		}
		p.Name = &name
	}
	if u.Slug != nil && !ValidSlug(*u.Slug) {
		return p, ErrInvalid
	}
	if u.AllowedDomains != nil {
		domains := make([]string, 0, len(*u.AllowedDomains))
		for _, d := range *u.AllowedDomains {
			if !ValidDomain(d) {
				return p, ErrInvalid
			}
			if identity.IsPublicEmailDomain(d) {
				return p, &DomainNotAllowedError{Domain: d}
			}
			if !slices.Contains(domains, d) {
				domains = append(domains, d)
			}
		}
		if len(domains) > MaxAllowedDomains {
			return p, ErrInvalid
		}
		p.AllowedDomains = domains
	}
	p.DomainJoin = u.DomainJoin
	return p, nil
}

// changed lists the fields u sets, for the audit event.
func changed(u Update) []string {
	out := []string{}
	if u.Name != nil {
		out = append(out, "name")
	}
	if u.AllowedDomains != nil {
		out = append(out, "allowed_domains")
	}
	if u.DomainJoin != nil {
		out = append(out, "domain_join")
	}
	return out
}

// lockMember row-locks the organization slug for user's membership in it.
func lockMember(ctx context.Context, q *db.Queries, user uuid.UUID, slug string) (db.LockMemberOrganizationRow, error) {
	r, err := q.LockMemberOrganization(ctx, db.LockMemberOrganizationParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, fmt.Errorf("orgs: lock organization: %w", err)
	}
	return r, nil
}

func detail(r db.LockMemberOrganizationRow) Detail {
	domains := r.AllowedDomains
	if domains == nil {
		domains = []string{}
	}
	return Detail{
		Org:            Org{ID: r.ID, Slug: r.Slug, Name: r.Name, Role: r.Role, CreatedAt: r.CreatedAt},
		AllowedDomains: domains,
		DomainJoin:     r.DomainJoin,
	}
}
