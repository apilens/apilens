// Package orgs creates organizations and answers whether an organization
// slug is free.
//
// Creating an organization writes the organization, its creator's owner
// membership, the org.created outbox row (ADR 0006) and the org.created audit
// event in one transaction, so either all of them exist or none does.
// Organization slugs are globally unique among active organizations; the
// partial unique index organizations_slug_active is the final arbiter, so two
// concurrent creates of one slug end with exactly one winner.
package orgs

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// SlugPattern is the slug rule of organizations.slug (migration 00001):
// lower-case letters, digits and hyphens, starting with a letter or digit,
// at most 63 characters.
const SlugPattern = `^[a-z0-9][a-z0-9-]{0,62}$`

// MaxSlugLen is the longest slug SlugPattern admits.
const MaxSlugLen = 63

// MaxSuggestions bounds the alternatives offered for a taken slug.
const MaxSuggestions = 3

// RoleOwner is the membership role of an organization's creator.
const RoleOwner = "owner"

var slugRE = regexp.MustCompile(SlugPattern)

// reserved slugs are refused for organizations: product, infrastructure and
// route names that would be confusing or spoofable as an organization, and
// path segments under /api/v1/orgs/ that are not organizations.
var reserved = []string{
	"about", "account", "admin", "api", "apilens", "app", "apps", "assets",
	"auth", "billing", "blog", "cdn", "console", "dashboard", "docs", "email",
	"help", "ingest", "invite", "invitations", "login", "logout", "mail", "me",
	"new", "oauth", "onboarding", "org", "orgs", "organizations", "pricing",
	"privacy", "projects", "root", "security", "settings", "sign-in",
	"sign-up", "signin", "signup", "slug-available", "sso", "static", "status", "support",
	"system", "terms", "users", "www",
}

// Reserved reports whether slug is reserved and can never be used.
func Reserved(slug string) bool { return slices.Contains(reserved, slug) }

// ValidSlug reports whether slug matches SlugPattern.
func ValidSlug(slug string) bool { return slugRE.MatchString(slug) }

// Errors returned by Service.
var (
	// ErrInvalid: the name or slug is unusable.
	ErrInvalid = errors.New("orgs: invalid name or slug")
	// ErrUserGone: the creating user no longer exists.
	ErrUserGone = errors.New("orgs: user not found")
)

// SlugTakenError is returned by Create when the slug is reserved or used by
// another active organization. Suggestions are free alternatives.
type SlugTakenError struct {
	Suggestions []string
}

func (e *SlugTakenError) Error() string { return "orgs: slug taken" }

// Auditor records audit events; *audit.Recorder satisfies it. Record must
// write in the transaction audit.WithTx puts in the context.
type Auditor interface {
	Record(ctx context.Context, e audit.Event) error
}

// Org is a created organization as seen by its creator.
type Org struct {
	ID        uuid.UUID
	Slug      string
	Name      string
	Role      string
	CreatedAt time.Time
}

// Service creates organizations and checks slugs.
type Service struct {
	pool  *pgxpool.Pool
	audit Auditor
}

// New returns a Service over pool.
func New(pool *pgxpool.Pool, auditor Auditor) *Service {
	return &Service{pool: pool, audit: auditor}
}

// Create creates the organization slug named name, owned by owner. name is
// trimmed. A reserved or taken slug returns *SlugTakenError.
func (s *Service) Create(ctx context.Context, owner uuid.UUID, name, slug string) (Org, error) {
	name = strings.TrimSpace(name)
	if name == "" || !ValidSlug(slug) {
		return Org{}, ErrInvalid
	}
	if Reserved(slug) {
		return Org{}, s.taken(ctx, slug)
	}
	org, err := s.create(ctx, owner, name, slug)
	switch {
	case isViolation(err, "23505", "organizations_slug_active"):
		return Org{}, s.taken(ctx, slug)
	case isViolation(err, "23503", ""):
		return Org{}, ErrUserGone
	case err != nil:
		return Org{}, err
	}
	return org, nil
}

func (s *Service) create(ctx context.Context, owner uuid.UUID, name, slug string) (Org, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Org{}, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	o, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{ID: uuid.New(), Slug: slug, Name: name, CreatedBy: &owner})
	if err != nil {
		return Org{}, fmt.Errorf("orgs: create organization: %w", err)
	}
	if _, err := q.CreateMembership(ctx, db.CreateMembershipParams{OrgID: o.ID, UserID: owner, Role: RoleOwner}); err != nil {
		return Org{}, fmt.Errorf("orgs: create owner membership: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.OrgCreated, o.ID, outbox.OrgCreatedPayload{OrgID: o.ID, OwnerUserID: owner}); err != nil {
		return Org{}, err
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &owner,
		Actor: &owner,
		Kind:  audit.OrgCreated,
		Meta:  map[string]any{"org_id": o.ID.String(), "slug": o.Slug},
	}); err != nil {
		return Org{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Org{}, fmt.Errorf("orgs: commit: %w", err)
	}
	return Org{ID: o.ID, Slug: o.Slug, Name: o.Name, Role: RoleOwner, CreatedAt: o.CreatedAt}, nil
}

// taken builds the SlugTakenError for slug.
func (s *Service) taken(ctx context.Context, slug string) error {
	sug, err := s.Suggest(ctx, slug)
	if err != nil {
		return err
	}
	return &SlugTakenError{Suggestions: sug}
}

// Available reports whether slug can be used for a new organization and,
// when it cannot, up to MaxSuggestions free alternatives. An invalid slug is
// ErrInvalid.
func (s *Service) Available(ctx context.Context, slug string) (bool, []string, error) {
	if !ValidSlug(slug) {
		return false, nil, ErrInvalid
	}
	if !Reserved(slug) {
		taken, err := db.New(s.pool).OrganizationSlugTaken(ctx, slug)
		if err != nil {
			return false, nil, fmt.Errorf("orgs: check slug: %w", err)
		}
		if !taken {
			return true, []string{}, nil
		}
	}
	sug, err := s.Suggest(ctx, slug)
	return false, sug, err
}

// Suggest returns up to MaxSuggestions valid, unreserved slugs derived from
// slug that no active organization uses: slug-2, slug-3, … first, then
// random suffixes. A suggestion can still be taken by the time it is used;
// Create answers that with fresh suggestions.
func (s *Service) Suggest(ctx context.Context, slug string) ([]string, error) {
	out, err := SuggestSlugs(ctx, slug, db.New(s.pool).TakenOrganizationSlugs)
	if err != nil {
		return nil, fmt.Errorf("orgs: suggest slugs: %w", err)
	}
	return out, nil
}

// SuggestSlugs returns up to MaxSuggestions valid, unreserved slugs derived
// from slug that used does not report as taken: slug-2, slug-3, … first,
// then random suffixes. used returns which of the candidates are in use.
// Projects share it with organizations.
func SuggestSlugs(ctx context.Context, slug string, used func(context.Context, []string) ([]string, error)) ([]string, error) {
	out := []string{}
	for _, candidates := range [][]string{numbered(slug), randomized(slug)} {
		taken, err := used(ctx, candidates)
		if err != nil {
			return nil, err
		}
		for _, c := range candidates {
			if len(out) == MaxSuggestions {
				return out, nil
			}
			if !slices.Contains(taken, c) && !slices.Contains(out, c) && ValidSlug(c) && !Reserved(c) {
				out = append(out, c)
			}
		}
	}
	return out, nil
}

// numbered returns slug-2 … slug-9, the base cut so each fits MaxSlugLen.
func numbered(slug string) []string {
	base := stem(slug, 2)
	out := make([]string, 0, 8)
	for n := 2; n <= 9; n++ {
		out = append(out, base+"-"+strconv.Itoa(n))
	}
	return out
}

// randomized returns slugs with random 4-character suffixes.
func randomized(slug string) []string {
	base := stem(slug, 4)
	out := make([]string, 0, MaxSuggestions*2)
	for range MaxSuggestions * 2 {
		out = append(out, base+"-"+randomSuffix(4))
	}
	return out
}

// stem cuts slug so that "-" plus a suffixLen suffix still fits MaxSlugLen,
// dropping trailing hyphens so the result never has "--" before the suffix.
func stem(slug string, suffixLen int) string {
	if limit := MaxSlugLen - 1 - suffixLen; len(slug) > limit {
		slug = slug[:limit]
	}
	return strings.TrimRight(slug, "-")
}

const suffixAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = suffixAlphabet[int(b[i])%len(suffixAlphabet)]
	}
	return string(b)
}

// isViolation reports whether err is the Postgres error code, on constraint
// when it is not empty.
func isViolation(err error, code, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code && (constraint == "" || pgErr.ConstraintName == constraint)
}
