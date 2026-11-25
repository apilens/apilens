package orgs

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// DomainNotVerifiedError is returned by Update when a domain is added that
// the acting user's own verified email is not at: otherwise one organization
// could offer "join" to everyone at a domain it has nothing to do with.
type DomainNotVerifiedError struct {
	Domain string
}

func (e *DomainNotVerifiedError) Error() string {
	return "orgs: domain not verified: " + e.Domain
}

// DomainTakenError is returned by Update when another active organization
// already allows joining with a domain: a domain belongs to one of them.
type DomainTakenError struct {
	Domain string
}

func (e *DomainTakenError) Error() string {
	return "orgs: domain already claimed: " + e.Domain
}

// addedDomains returns the domains of next that cur does not already have,
// in order: only these need to be verified.
func addedDomains(cur, next []string) []string {
	var added []string
	for _, d := range next {
		if !slices.Contains(cur, d) {
			added = append(added, d)
		}
	}
	return added
}

// unverifiedDomain returns the first added domain that email is not at (an
// exact match, so a subdomain does not count), or "" when all of them are.
func unverifiedDomain(added []string, email string) string {
	own := ""
	if at := strings.LastIndexByte(email, '@'); at >= 0 {
		own = strings.ToLower(strings.TrimSuffix(email[at+1:], "."))
	}
	for _, d := range added {
		if own == "" || d != own {
			return d
		}
	}
	return ""
}

// checkDomains enforces the join-domain rules for org: a domain newly added
// must be the one of user's own verified email, and no other active
// organization may already allow it. Runs in the Update transaction.
func checkDomains(ctx context.Context, q *db.Queries, user, org uuid.UUID, cur, next []string) error {
	added := addedDomains(cur, next)
	if len(added) > 0 {
		row, err := q.GetUserEmail(ctx, user)
		if err != nil {
			return fmt.Errorf("orgs: read acting user email: %w", err)
		}
		email := row.Email
		if row.EmailVerifiedAt == nil {
			email = ""
		}
		if d := unverifiedDomain(added, email); d != "" {
			return &DomainNotVerifiedError{Domain: d}
		}
	}
	for _, d := range next {
		_, err := q.OrganizationClaimingDomain(ctx, db.OrganizationClaimingDomainParams{Domain: d, OrgID: org})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
		case err != nil:
			return fmt.Errorf("orgs: domain claim lookup: %w", err)
		default:
			return &DomainTakenError{Domain: d}
		}
	}
	return nil
}

// checkSSODomains enforces the same rule for an SSO connection's domains,
// which decide whose accounts the provider may sign in: a domain newly listed
// must be the acting owner's own verified domain or one the organization
// already allows, and no other organization may list it.
func checkSSODomains(ctx context.Context, q *db.Queries, user, org uuid.UUID, allowed, cur, next []string) error {
	added := addedDomains(append(slices.Clone(allowed), cur...), next)
	if len(added) > 0 {
		row, err := q.GetUserEmail(ctx, user)
		if err != nil {
			return fmt.Errorf("orgs: read acting user email: %w", err)
		}
		email := row.Email
		if row.EmailVerifiedAt == nil {
			email = ""
		}
		if d := unverifiedDomain(added, email); d != "" {
			return &DomainNotVerifiedError{Domain: d}
		}
	}
	taken, err := q.SSODomainsOfOtherOrgs(ctx, db.SSODomainsOfOtherOrgsParams{OrgID: org, Domains: next})
	if err != nil {
		return fmt.Errorf("orgs: check sso domains: %w", err)
	}
	if len(taken) > 0 {
		return &SSODomainTakenError{Domains: taken}
	}
	return nil
}
