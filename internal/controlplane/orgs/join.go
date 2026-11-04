package orgs

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/identity/audit"
)

// MaxMemberInitials bounds the member initials shown for a joinable
// organization.
const MaxMemberInitials = 3

// Joinable is an organization a user may join through their verified email
// domain.
type Joinable struct {
	ID             uuid.UUID
	Slug           string
	Name           string
	MemberCount    int64
	ProjectCount   int64
	MemberInitials []string
}

// JoinDomain returns the domain of email that verified-domain join matches
// against allowed_domains (lower-case, without "@"), or "" when email has no
// usable domain or is at a public email provider, which never matches.
func JoinDomain(email string) string {
	at := strings.LastIndexByte(email, '@')
	if at < 0 {
		return ""
	}
	domain := strings.TrimSuffix(strings.ToLower(email[at+1:]), ".")
	if !ValidDomain(domain) || identity.IsPublicEmailDomain(domain) {
		return ""
	}
	return domain
}

// Initials returns the initials of a display name: the first letters of its
// first and last words, upper-cased ("Ada Lovelace" → "AL", "Ada" → "A"). An
// email address uses its local part.
func Initials(display string) string {
	if at := strings.IndexByte(display, '@'); at >= 0 {
		display = display[:at]
	}
	words := strings.FieldsFunc(display, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	if len(words) == 0 {
		return ""
	}
	first := func(w string) string {
		r, _ := utf8.DecodeRuneInString(w)
		return string(unicode.ToUpper(r))
	}
	out := first(words[0])
	if len(words) > 1 {
		out += first(words[len(words)-1])
	}
	return out
}

// joinDomain returns the verified email domain user may join organizations
// with, or "" when their email is unverified or at a public email provider.
func joinDomain(ctx context.Context, q *db.Queries, user uuid.UUID) (string, error) {
	u, err := q.GetUserEmail(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUserGone
	}
	if err != nil {
		return "", fmt.Errorf("orgs: get user: %w", err)
	}
	if u.EmailVerifiedAt == nil {
		return "", nil
	}
	return JoinDomain(u.Email), nil
}

// Joinable lists the active organizations user is not a member of that have
// domain join on and list user's verified email domain among their allowed
// domains, ordered by name. Users with an unverified email or one at a
// public email provider get none.
func (s *Service) Joinable(ctx context.Context, user uuid.UUID) ([]Joinable, error) {
	q := db.New(s.pool)
	domain, err := joinDomain(ctx, q, user)
	if err != nil || domain == "" {
		return []Joinable{}, err
	}
	rows, err := q.ListJoinableOrganizationsWithCounts(ctx, db.ListJoinableOrganizationsWithCountsParams{Domain: domain, UserID: user})
	if err != nil {
		return nil, fmt.Errorf("orgs: list joinable: %w", err)
	}
	out := make([]Joinable, 0, len(rows))
	for _, r := range rows {
		initials := make([]string, 0, MaxMemberInitials)
		for _, n := range r.MemberNames {
			if i := Initials(n); i != "" && len(initials) < MaxMemberInitials {
				initials = append(initials, i)
			}
		}
		out = append(out, Joinable{
			ID: r.ID, Slug: r.Slug, Name: r.Name,
			MemberCount: r.MemberCount, ProjectCount: r.ProjectCount, MemberInitials: initials,
		})
	}
	return out, nil
}

// Join makes user a member of the organization slug through their verified
// email domain: the organization must have domain join on and list the
// domain among its allowed domains, and the domain must not be a public
// email provider (ErrNotFound otherwise, indistinguishable from a missing
// organization). The membership, its membership.upserted outbox row and the
// member.joined audit event are written in one transaction. Joining an
// organization user already belongs to changes nothing and returns it with
// their current role; created reports whether a membership was added.
func (s *Service) Join(ctx context.Context, user uuid.UUID, slug string) (org Org, created bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Org{}, false, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	o, err := q.LockOrganizationBySlug(ctx, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return Org{}, false, ErrNotFound
	}
	if err != nil {
		return Org{}, false, fmt.Errorf("orgs: lock organization: %w", err)
	}
	org = Org{ID: o.ID, Slug: o.Slug, Name: o.Name, CreatedAt: o.CreatedAt}
	m, err := q.GetMembership(ctx, db.GetMembershipParams{OrgID: o.ID, UserID: user})
	switch {
	case err == nil:
		org.Role = m.Role
		return org, false, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return Org{}, false, fmt.Errorf("orgs: get membership: %w", err)
	}
	domain, err := joinDomain(ctx, q, user)
	if err != nil {
		return Org{}, false, err
	}
	if domain == "" || !o.DomainJoin || !slices.Contains(o.AllowedDomains, domain) {
		return Org{}, false, ErrNotFound
	}
	if _, err := q.CreateMembership(ctx, db.CreateMembershipParams{OrgID: o.ID, UserID: user, Role: RoleMember}); err != nil {
		return Org{}, false, fmt.Errorf("orgs: create membership: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.MembershipUpserted, o.ID, outbox.MembershipUpsertedPayload{OrgID: o.ID, UserID: user, Role: RoleMember}); err != nil {
		return Org{}, false, err
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.MemberJoined,
		Meta:  map[string]any{"org_id": o.ID.String(), "slug": o.Slug, "role": RoleMember, "domain": domain},
	}); err != nil {
		return Org{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Org{}, false, fmt.Errorf("orgs: commit: %w", err)
	}
	org.Role = RoleMember
	return org, true, nil
}
