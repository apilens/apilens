//go:build integration

package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/identity/audit"
	identitydb "github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

const acceptSuffix = "/accept"

func invitationLinkPath(token string) string {
	return strings.Replace(InvitationLinkPath, "{token}", token, 1)
}

// setupInvitationLinks serves the organization, invitation and invitation
// link endpoints over real Postgres; lookups are limited to perIP.
func setupInvitationLinks(t *testing.T, perIP ratelimit.Rate) (*orgsFixture, *orgs.InvitationService) {
	t.Helper()
	f := setupInvitations(t)
	client, err := cache.Connect(context.Background(), testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	limiter, err := ratelimit.New(client, testutil.Logger(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Lookup and accept never send email.
	svc := orgs.NewInvitations(f.pool, audit.New(f.pool), nil)
	NewInvitationLinks(svc, limiter, perIP, testutil.Logger(t)).Register(f.api)
	return f, svc
}

// inviteToken invites addr to slug as inviter and returns the emailed token.
func (f *orgsFixture) inviteToken(t *testing.T, inviter uuid.UUID, slug, addr, role string) string {
	t.Helper()
	resp := f.api.Post(orgPath(InvitationsPath, slug), as(inviter), invite(addr, role))
	if resp.Code != http.StatusOK {
		t.Fatalf("invite %s: %d %s", addr, resp.Code, resp.Body)
	}
	mails := f.invitationEmails(t)
	token, _ := mails[len(mails)-1].Data["token"].(string)
	if token == "" {
		t.Fatalf("no token emailed: %+v", mails)
	}
	return token
}

func (f *orgsFixture) problemCode(t *testing.T, path string, user uuid.UUID, post bool, status int, code string) {
	t.Helper()
	var args []any
	if user != uuid.Nil {
		args = append(args, as(user))
	}
	var resp *httptest.ResponseRecorder
	if post {
		resp = f.api.Post(path, append(args, map[string]any{})...)
	} else {
		resp = f.api.Get(path, args...)
	}
	if p := decode[problem](t, resp); resp.Code != status || p.Code != code {
		t.Fatalf("%s: %d %s, want %d %s", path, resp.Code, resp.Body, status, code)
	}
}

func TestLookupInvitation(t *testing.T) {
	f, _ := setupInvitationLinks(t, ratelimit.Rate{})
	owner := f.namedUser(t, "li-owner@example.com", "Ada Lovelace")
	f.mustCreate(t, owner, "Acme", "acme")
	token := f.inviteToken(t, owner, "acme", "Bob.Smith@example.com", "admin")

	// Public: no session needed.
	resp := f.api.Get(invitationLinkPath(token))
	if resp.Code != http.StatusOK {
		t.Fatalf("lookup: %d %s", resp.Code, resp.Body)
	}
	got := decode[InvitationPreview](t, resp)
	if got.Org.Name != "Acme" || got.Org.Slug != "acme" || got.InviterName != "Ada Lovelace" || got.EmailMasked != "B***@example.com" ||
		got.Role != "admin" || time.Until(got.ExpiresAt) < orgs.InvitationTTL-time.Minute {
		t.Fatalf("preview = %+v", got)
	}

	f.problemCode(t, invitationLinkPath("not-a-token"), uuid.Nil, false, http.StatusUnauthorized, "invalid_token")

	// Expired.
	f.exec(t, `UPDATE invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day' WHERE email = 'Bob.Smith@example.com'`)
	f.problemCode(t, invitationLinkPath(token), uuid.Nil, false, http.StatusGone, "invite_expired")

	// Revoked.
	revoked := f.inviteToken(t, owner, "acme", "carol@example.com", "member")
	f.exec(t, `UPDATE invitations SET revoked_at = now() WHERE email = 'carol@example.com'`)
	f.problemCode(t, invitationLinkPath(revoked), uuid.Nil, false, http.StatusGone, "invite_expired")

	// A deleted organization's invitation is unknown.
	gone := f.inviteToken(t, owner, "acme", "dan@example.com", "member")
	f.exec(t, `UPDATE organizations SET deleted_at = now() WHERE slug = 'acme'`)
	f.problemCode(t, invitationLinkPath(gone), uuid.Nil, false, http.StatusUnauthorized, "invalid_token")
}

func TestLookupInvitationRateLimited(t *testing.T) {
	f, _ := setupInvitationLinks(t, ratelimit.Rate{Limit: 2, Window: time.Minute})
	for i := range 2 {
		if resp := f.api.Get(invitationLinkPath("unknown")); resp.Code != http.StatusUnauthorized {
			t.Fatalf("lookup %d: %d %s", i, resp.Code, resp.Body)
		}
	}
	resp := f.api.Get(invitationLinkPath("unknown"))
	if resp.Code != http.StatusTooManyRequests || resp.Header().Get("Retry-After") == "" {
		t.Fatalf("over limit: %d %v %s", resp.Code, resp.Header(), resp.Body)
	}
}

func TestAcceptInvitation(t *testing.T) {
	f, _ := setupInvitationLinks(t, ratelimit.Rate{})
	owner := f.user(t, "ai-owner@example.com")
	invitee := f.user(t, "ai-bob@example.com")
	other := f.user(t, "ai-carol@example.com")
	org := f.mustCreate(t, owner, "Acme", "acme")
	token := f.inviteToken(t, owner, "acme", "AI-Bob@Example.com", "viewer")
	accept := invitationLinkPath(token) + acceptSuffix

	f.problemCode(t, accept, uuid.Nil, true, http.StatusUnauthorized, "unauthenticated")
	f.problemCode(t, invitationLinkPath("nope")+acceptSuffix, invitee, true, http.StatusUnauthorized, "invalid_token")
	// Someone else cannot use the link.
	f.problemCode(t, accept, other, true, http.StatusForbidden, "invite_email_mismatch")
	if f.role(t, "acme", other) != "" {
		t.Fatal("mismatched user joined")
	}
	// Before accepting, the invitee cannot see the organization.
	if resp := f.api.Get(orgPath(OrgPath, "acme"), as(invitee)); resp.Code == http.StatusOK {
		t.Fatalf("org before accept: %d", resp.Code)
	}

	resp := f.api.Post(accept, as(invitee), map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("accept: %d %s", resp.Code, resp.Body)
	}
	got := decode[AcceptedInvitation](t, resp)
	if !got.Joined || got.Org.ID != org.ID || got.Org.Slug != "acme" || got.Org.Name != "Acme" || got.Org.Role != "viewer" {
		t.Fatalf("accepted = %+v", got)
	}
	if r := f.role(t, "acme", invitee); r != "viewer" {
		t.Fatalf("role = %q", r)
	}
	if n := f.count(t, `SELECT count(*) FROM memberships WHERE user_id = $1 AND invited_by = $2`, invitee, owner); n != 1 {
		t.Fatal("membership does not record the inviter")
	}
	if n := f.count(t, `SELECT count(*) FROM invitations WHERE email = 'ai-bob@example.com' AND accepted_at IS NOT NULL`); n != 1 {
		t.Fatal("invitation not marked accepted")
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'membership.upserted' AND payload->>'user_id' = $1 AND payload->>'role' = 'viewer' AND aggregate_id = $2`, invitee.String(), org.ID); n != 1 {
		t.Fatalf("outbox rows = %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'invitation.accepted' AND user_id = $1 AND actor_user_id = $1 AND metadata->>'org_id' = $2 AND metadata->>'role' = 'viewer'`, invitee, org.ID); n != 1 {
		t.Fatalf("audit events = %d", n)
	}
	// The membership reached authorization through the outbox.
	if resp := f.api.Get(orgPath(OrgPath, "acme"), as(invitee)); resp.Code != http.StatusOK {
		t.Fatalf("org after accept: %d %s", resp.Code, resp.Body)
	}

	// Accepting twice is idempotent: same answer, nothing written again.
	resp = f.api.Post(accept, as(invitee), map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("accept again: %d %s", resp.Code, resp.Body)
	}
	if again := decode[AcceptedInvitation](t, resp); again.Joined || again.Org.ID != org.ID || again.Org.Role != "viewer" {
		t.Fatalf("accepted again = %+v", again)
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'membership.upserted' AND payload->>'user_id' = $1`, invitee.String()); n != 1 {
		t.Fatalf("outbox rows after second accept = %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'invitation.accepted'`); n != 1 {
		t.Fatalf("audit events after second accept = %d", n)
	}
	// Others still cannot replay it, and the public page shows it as used.
	f.problemCode(t, accept, other, true, http.StatusForbidden, "invite_email_mismatch")
	f.problemCode(t, invitationLinkPath(token), uuid.Nil, false, http.StatusGone, "invite_expired")

	// Once the member is removed, the used link does not let them back in.
	f.exec(t, `DELETE FROM memberships WHERE user_id = $1`, invitee)
	f.problemCode(t, accept, invitee, true, http.StatusGone, "invite_expired")
}

func TestAcceptInvitationStates(t *testing.T) {
	f, _ := setupInvitationLinks(t, ratelimit.Rate{})
	owner := f.user(t, "as-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")

	// Expired and revoked invitations cannot be accepted.
	expiredUser := f.user(t, "as-expired@example.com")
	expired := f.inviteToken(t, owner, "acme", "as-expired@example.com", "member")
	f.exec(t, `UPDATE invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day' WHERE email = 'as-expired@example.com'`)
	f.problemCode(t, invitationLinkPath(expired)+acceptSuffix, expiredUser, true, http.StatusGone, "invite_expired")

	revokedUser := f.user(t, "as-revoked@example.com")
	revoked := f.inviteToken(t, owner, "acme", "as-revoked@example.com", "member")
	f.exec(t, `UPDATE invitations SET revoked_at = now() WHERE email = 'as-revoked@example.com'`)
	f.problemCode(t, invitationLinkPath(revoked)+acceptSuffix, revokedUser, true, http.StatusGone, "invite_expired")

	// An unverified email does not match.
	unverified, err := identitydb.New(f.pool).CreateUser(f.ctx, identitydb.CreateUserParams{ID: uuid.New(), Email: "as-unverified@example.com", Name: "Una"})
	if err != nil {
		t.Fatal(err)
	}
	pending := f.inviteToken(t, owner, "acme", "as-unverified@example.com", "member")
	f.problemCode(t, invitationLinkPath(pending)+acceptSuffix, unverified.ID, true, http.StatusForbidden, "invite_email_mismatch")

	// A user who joined meanwhile keeps their role; the invitation is used.
	member := f.user(t, "as-member@example.com")
	token := f.inviteToken(t, owner, "acme", "as-member@example.com", "admin")
	f.join(t, "acme", member, "viewer")
	resp := f.api.Post(invitationLinkPath(token)+acceptSuffix, as(member), map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("accept as member: %d %s", resp.Code, resp.Body)
	}
	if got := decode[AcceptedInvitation](t, resp); got.Joined || got.Org.Role != "viewer" {
		t.Fatalf("accepted as member = %+v", got)
	}
	if f.role(t, "acme", member) != "viewer" {
		t.Fatal("role changed")
	}
	if n := f.count(t, `SELECT count(*) FROM invitations WHERE email = 'as-member@example.com' AND accepted_at IS NOT NULL`); n != 1 {
		t.Fatal("invitation not marked accepted")
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'membership.upserted' AND payload->>'user_id' = $1 AND payload->>'role' = 'admin'`, member.String()); n != 0 {
		t.Fatal("membership upserted with the invited role")
	}
}

func TestAcceptInvitationConcurrently(t *testing.T) {
	f, svc := setupInvitationLinks(t, ratelimit.Rate{})
	owner := f.user(t, "ac-owner@example.com")
	invitee := f.user(t, "ac-bob@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	token := f.inviteToken(t, owner, "acme", "ac-bob@example.com", "member")

	const n = 5
	var wg sync.WaitGroup
	results := make([]orgs.AcceptedInvitation, n)
	errs := make([]error, n)
	for i := range n {
		wg.Go(func() { results[i], errs[i] = svc.Accept(f.ctx, invitee, token) })
	}
	wg.Wait()
	joined := 0
	for i := range n {
		if errs[i] != nil {
			t.Fatalf("accept %d: %v", i, errs[i])
		}
		if results[i].Org.Role != "member" {
			t.Fatalf("accept %d = %+v", i, results[i])
		}
		if results[i].Joined {
			joined++
		}
	}
	if joined != 1 {
		t.Fatalf("joined %d times", joined)
	}
	if c := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'membership.upserted' AND payload->>'user_id' = $1`, invitee.String()); c != 1 {
		t.Fatalf("outbox rows = %d", c)
	}
}
