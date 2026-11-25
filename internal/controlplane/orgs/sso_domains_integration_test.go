//go:build integration

package orgs

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/testutil"
)

// TestPutSSODomainsVerifiedIntegration guards the impersonation path: an SSO
// connection signs in anyone at its domains, so a domain may only be listed by
// an owner whose own verified email is at it (or one the organization already
// allows), and never while another organization lists it.
func TestPutSSODomainsVerifiedIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	auditor := audit.New(pool)
	svc := New(pool, auditor)
	sealer, err := idkeys.NewSealer(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	sso := NewSSOConnections(pool, auditor, sealer)

	user := func(email string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, email_verified_at) VALUES ($1, $2, now())`, id, email); err != nil {
			t.Fatal(err)
		}
		return id
	}
	secret := "s3cret"
	settings := func(domains ...string) SSOSettings {
		return SSOSettings{
			Issuer:       "https://idp.example.com",
			ClientID:     "client",
			ClientSecret: &secret,
			DefaultRole:  RoleViewer,
			Domains:      domains,
		}
	}

	ada := user("ada@acme.dev")
	acme, err := svc.Create(ctx, ada, "Acme", "acme-sso-domains")
	if err != nil {
		t.Fatal(err)
	}

	t.Run("a stranger's domain is refused", func(t *testing.T) {
		var nv *DomainNotVerifiedError
		_, _, err := sso.Put(ctx, ada, acme.Slug, settings("globex.com"))
		if !errors.As(err, &nv) || nv.Domain != "globex.com" {
			t.Fatalf("err = %v, want domain_not_verified for globex.com", err)
		}
	})

	t.Run("their own domain is accepted", func(t *testing.T) {
		if _, _, err := sso.Put(ctx, ada, acme.Slug, settings("acme.dev")); err != nil {
			t.Fatalf("put: %v", err)
		}
	})

	t.Run("a domain the organization already allows is accepted", func(t *testing.T) {
		list := []string{"acme.dev"}
		if _, err := svc.Update(ctx, ada, acme.Slug, Update{AllowedDomains: &list}); err != nil {
			t.Fatal(err)
		}
		// mia is an owner whose email is elsewhere: she may keep the list the
		// organization has already verified.
		mia := user("mia@other.dev")
		if _, err := pool.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, acme.ID, mia); err != nil {
			t.Fatal(err)
		}
		if _, _, err := sso.Put(ctx, mia, acme.Slug, settings("acme.dev")); err != nil {
			t.Fatalf("put by another owner: %v", err)
		}
	})

	t.Run("another organization cannot list the same domain", func(t *testing.T) {
		bob := user("bob@acme.dev")
		other, err := svc.Create(ctx, bob, "Acme Side", "acme-side-sso")
		if err != nil {
			t.Fatal(err)
		}
		var taken *SSODomainTakenError
		_, _, err = sso.Put(ctx, bob, other.Slug, settings("acme.dev"))
		if !errors.As(err, &taken) {
			t.Fatalf("err = %v, want sso_domain_taken", err)
		}
	})
}
