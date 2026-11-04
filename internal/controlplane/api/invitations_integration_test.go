//go:build integration

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// setupInvitations serves the organization and invitation endpoints over
// real Postgres; invitation emails land in river_job and are never sent.
func setupInvitations(t *testing.T) *orgsFixture {
	t.Helper()
	f := setupOrgs(t, ratelimit.Rate{})
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(f.pool, config.JobsConfig{}, reg, time.Second, testutil.Logger(t), prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	NewInvitations(orgs.NewInvitations(f.pool, audit.New(f.pool), jc), testutil.Logger(t)).Register(f.api)
	return f
}

// invitationEmails returns the enqueued invitation emails, oldest first.
func (f *orgsFixture) invitationEmails(t *testing.T) []email.SendArgs {
	t.Helper()
	rows, err := f.pool.Query(f.ctx, `SELECT args FROM river_job WHERE kind = 'email.send' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []email.SendArgs
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var a email.SendArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			t.Fatal(err)
		}
		if a.Template == email.TemplateInvitation {
			out = append(out, a)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

type inviteResponse struct {
	Results []InviteResult `json:"results"`
}

func invite(entries ...string) map[string]any {
	list := make([]map[string]any, 0, len(entries)/2)
	for i := 0; i+1 < len(entries); i += 2 {
		list = append(list, map[string]any{"email": entries[i], "role": entries[i+1]})
	}
	return map[string]any{"invites": list}
}

func invitationPath(slug, id, suffix string) string {
	return orgPath(InvitationsPath, slug) + "/" + id + suffix
}

func TestCreateInvitations(t *testing.T) {
	f := setupInvitations(t)
	owner := f.user(t, "ci-owner@example.com")
	admin := f.user(t, "ci-admin@example.com")
	member := f.user(t, "ci-member@example.com")
	viewer := f.user(t, "ci-viewer@example.com")
	stranger := f.user(t, "ci-stranger@example.com")
	org := f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")

	// An admin invites: new addresses are emailed, members (any case) are
	// skipped, repeats within the call are reported once.
	resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(admin), invite(
		"new-one@example.com", "member",
		"CI-Member@Example.com", "viewer",
		"new-two@example.com", "admin",
		"NEW-ONE@example.com", "viewer",
	))
	if resp.Code != http.StatusOK {
		t.Fatalf("invite: %d %s", resp.Code, resp.Body)
	}
	got := decode[inviteResponse](t, resp).Results
	want := []struct{ email, status string }{
		{"new-one@example.com", "invited"},
		{"CI-Member@Example.com", "already_member"},
		{"new-two@example.com", "invited"},
		{"NEW-ONE@example.com", "duplicate"},
	}
	if len(got) != len(want) {
		t.Fatalf("results = %+v", got)
	}
	for i, w := range want {
		if got[i].Email != w.email || got[i].Status != w.status || (got[i].Invitation != nil) != (w.status == "invited") {
			t.Errorf("result %d = %+v, want %s %s", i, got[i], w.email, w.status)
		}
	}
	first := got[0].Invitation
	if first.Role != "member" || first.InvitedBy == nil || first.InvitedBy.ID != admin.String() || first.InvitedBy.Email != "ci-admin@example.com" ||
		first.ResentAt != nil || first.ExpiresAt.Sub(first.CreatedAt) < 7*24*time.Hour-time.Minute {
		t.Fatalf("invitation = %+v", first)
	}

	// Each sent invitation is emailed with its own token, which is stored
	// only as a hash.
	mails := f.invitationEmails(t)
	if len(mails) != 2 {
		t.Fatalf("emails = %+v", mails)
	}
	m := mails[0]
	token, _ := m.Data["token"].(string)
	if m.To != "new-one@example.com" || m.Data["org"] != "Acme" || m.Data["inviter"] != "Ada" || m.Data["role"] != "member" || token == "" || m.Data["expires_at"] == "" {
		t.Fatalf("email = %+v", m)
	}
	if n := f.count(t, `SELECT count(*) FROM invitations WHERE token_hash = $1 AND id = $2`, orgs.HashInvitationToken(token), first.ID); n != 1 {
		t.Fatalf("token hash not stored")
	}
	if n := f.count(t, `SELECT count(*) FROM invitations WHERE token_hash = $1`, token); n != 0 {
		t.Fatalf("raw token stored")
	}

	// Audited as invitation.sent by the inviter.
	var meta map[string]any
	if err := f.pool.QueryRow(f.ctx, `SELECT metadata FROM audit_events WHERE event = 'invitation.sent' AND actor_user_id = $1 AND metadata->>'email' = 'new-one@example.com'`, admin).Scan(&meta); err != nil {
		t.Fatal(err)
	}
	if meta["org_id"] != org.ID || meta["invitation_id"] != first.ID || meta["role"] != "member" || meta["resent"] != false {
		t.Fatalf("audit meta = %v", meta)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'invitation.sent'`); n != 2 {
		t.Fatalf("invitation.sent events = %d", n)
	}

	// Inviting a pending address again replaces its invitation: the old link
	// stops working and exactly one invitation stays pending.
	resp = f.api.Post(orgPath(InvitationsPath, "acme"), as(owner), invite("New-One@example.com", "viewer"))
	if resp.Code != http.StatusOK {
		t.Fatalf("reinvite: %d %s", resp.Code, resp.Body)
	}
	if r := decode[inviteResponse](t, resp).Results; len(r) != 1 || r[0].Status != "replaced" || r[0].Invitation.Role != "viewer" || r[0].Invitation.ID == first.ID {
		t.Fatalf("reinvite = %+v", r)
	}
	if n := f.count(t, `SELECT count(*) FROM invitations WHERE id = $1 AND revoked_at IS NOT NULL`, first.ID); n != 1 {
		t.Fatal("replaced invitation not revoked")
	}
	if n := f.count(t, `SELECT count(*) FROM invitations WHERE email = 'new-one@example.com' AND revoked_at IS NULL AND accepted_at IS NULL`); n != 1 {
		t.Fatalf("pending invitations for the address = %d", n)
	}
	if mails := f.invitationEmails(t); len(mails) != 3 || mails[2].Data["role"] != "viewer" {
		t.Fatalf("emails after reinvite = %+v", mails)
	}

	// Invitations do not change who can see what: no outbox rows.
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic LIKE 'invitation%'`); n != 0 {
		t.Fatalf("outbox rows = %d", n)
	}

	before := f.count(t, `SELECT count(*) FROM invitations`)
	for _, tc := range []struct {
		name   string
		caller uuid.UUID
		slug   string
		body   map[string]any
		status int
		code   string
	}{
		{"member invites", member, "acme", invite("x@example.com", "member"), http.StatusForbidden, "forbidden"},
		{"viewer invites", viewer, "acme", invite("x@example.com", "member"), http.StatusForbidden, "forbidden"},
		{"stranger invites", stranger, "acme", invite("x@example.com", "member"), http.StatusForbidden, "forbidden"},
		{"unknown org", owner, "missing", invite("x@example.com", "member"), http.StatusForbidden, "forbidden"},
		{"display-name address", owner, "acme", invite("X <x@example.com>", "member"), 0, ""},
	} {
		resp := f.api.Post(orgPath(InvitationsPath, tc.slug), as(tc.caller), tc.body)
		if tc.status == 0 {
			if resp.Code < 400 {
				t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
			}
			continue
		}
		expectProblem(t, tc.name, resp, tc.status, tc.code)
	}
	if n := f.count(t, `SELECT count(*) FROM invitations`); n != before {
		t.Fatalf("refused calls created %d invitations", n-before)
	}
}

func TestCreateInvitationsLimits(t *testing.T) {
	f := setupInvitations(t)
	owner := f.user(t, "cl-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")

	entries := make([]string, 0, 2*(orgs.MaxInvites+1))
	for i := range orgs.MaxInvites + 1 {
		entries = append(entries, "bulk-"+strings.Repeat("x", i)+"@example.com", "member")
	}
	if resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(owner), invite(entries...)); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("51 invites: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(owner), invite("o@example.com", "owner")); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("owner role: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM invitations`); n != 0 {
		t.Fatalf("invitations = %d", n)
	}

	resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(owner), invite(entries[:2*orgs.MaxInvites]...))
	if resp.Code != http.StatusOK {
		t.Fatalf("50 invites: %d %s", resp.Code, resp.Body)
	}
	if r := decode[inviteResponse](t, resp).Results; len(r) != orgs.MaxInvites {
		t.Fatalf("results = %d", len(r))
	}
	if mails := f.invitationEmails(t); len(mails) != orgs.MaxInvites {
		t.Fatalf("emails = %d", len(mails))
	}
}

func TestListInvitations(t *testing.T) {
	f := setupInvitations(t)
	owner := f.user(t, "li-owner@example.com")
	admin := f.user(t, "li-admin@example.com")
	member := f.user(t, "li-member@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreate(t, owner, "Other", "other")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	for _, body := range []map[string]any{
		invite("a@example.com", "member"),
		invite("b@example.com", "viewer"),
	} {
		if resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(owner), body); resp.Code != http.StatusOK {
			t.Fatalf("invite: %d %s", resp.Code, resp.Body)
		}
	}
	if resp := f.api.Post(orgPath(InvitationsPath, "other"), as(owner), invite("c@example.com", "member")); resp.Code != http.StatusOK {
		t.Fatalf("invite other: %d %s", resp.Code, resp.Body)
	}
	// Accepted and revoked invitations are not pending.
	if _, err := f.pool.Exec(f.ctx, `UPDATE invitations SET accepted_at = now() WHERE email = 'b@example.com'`); err != nil {
		t.Fatal(err)
	}
	if resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(owner), invite("d@example.com", "admin")); resp.Code != http.StatusOK {
		t.Fatalf("invite: %d %s", resp.Code, resp.Body)
	}
	// An expired invitation stays listed so it can be resent.
	if _, err := f.pool.Exec(f.ctx, `UPDATE invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '2 days' WHERE email = 'a@example.com'`); err != nil {
		t.Fatal(err)
	}
	// An inviter whose account is gone is left out.
	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, admin); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE invitations SET invited_by = $1 WHERE email = 'd@example.com'`, admin); err != nil {
		t.Fatal(err)
	}

	resp := f.api.Get(orgPath(InvitationsPath, "acme"), as(owner))
	if resp.Code != http.StatusOK {
		t.Fatalf("list: %d %s", resp.Code, resp.Body)
	}
	list := decode[[]Invitation](t, resp)
	if len(list) != 2 || list[0].Email != "d@example.com" || list[1].Email != "a@example.com" {
		t.Fatalf("list = %+v", list)
	}
	if list[0].InvitedBy != nil || list[0].Role != "admin" {
		t.Fatalf("d = %+v", list[0])
	}
	if a := list[1]; a.InvitedBy == nil || a.InvitedBy.ID != owner.String() || a.InvitedBy.Name != "Ada" || !a.ExpiresAt.Before(time.Now()) {
		t.Fatalf("a = %+v", a)
	}
	if !strings.Contains(resp.Body.String(), `"resent_at":null`) {
		t.Fatalf("resent_at not null: %s", resp.Body)
	}

	expectProblem(t, "member lists", f.api.Get(orgPath(InvitationsPath, "acme"), as(member)), http.StatusForbidden, "forbidden")
	expectProblem(t, "unknown org", f.api.Get(orgPath(InvitationsPath, "missing"), as(owner)), http.StatusForbidden, "forbidden")
}

func TestResendInvitation(t *testing.T) {
	f := setupInvitations(t)
	owner := f.user(t, "ri-owner@example.com")
	admin := f.user(t, "ri-admin@example.com")
	member := f.user(t, "ri-member@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreate(t, owner, "Other", "other")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(owner), invite("r@example.com", "member"))
	if resp.Code != http.StatusOK {
		t.Fatalf("invite: %d %s", resp.Code, resp.Body)
	}
	inv := decode[inviteResponse](t, resp).Results[0].Invitation
	resend := func(caller uuid.UUID, slug, id string) *httptest.ResponseRecorder {
		return f.api.Post(invitationPath(slug, id, "/resend"), as(caller), map[string]any{})
	}

	// Within five minutes of the last email: rate_limited with retry_after.
	resp = resend(admin, "acme", inv.ID)
	if p := decode[problem](t, resp); resp.Code != http.StatusTooManyRequests || p.Code != "rate_limited" {
		t.Fatalf("cooldown: %d %s", resp.Code, resp.Body)
	}
	if ra := resp.Header().Get("Retry-After"); ra == "" || ra == "0" {
		t.Fatalf("Retry-After = %q", ra)
	}

	// After the cooldown an admin resends: new token, new expiry, the
	// original inviter stays, invitation.sent is audited.
	if _, err := f.pool.Exec(f.ctx, `UPDATE invitations SET created_at = now() - interval '6 minutes', expires_at = now() + interval '1 day' WHERE id = $1`, inv.ID); err != nil {
		t.Fatal(err)
	}
	oldMails := f.invitationEmails(t)
	resp = resend(admin, "acme", inv.ID)
	if resp.Code != http.StatusOK {
		t.Fatalf("resend: %d %s", resp.Code, resp.Body)
	}
	got := decode[Invitation](t, resp)
	if got.ID != inv.ID || got.ResentAt == nil || got.InvitedBy == nil || got.InvitedBy.ID != owner.String() || got.ExpiresAt.Before(time.Now().Add(6*24*time.Hour)) {
		t.Fatalf("resent = %+v", got)
	}
	mails := f.invitationEmails(t)
	if len(mails) != len(oldMails)+1 {
		t.Fatalf("emails = %+v", mails)
	}
	oldToken, newToken := oldMails[len(oldMails)-1].Data["token"], mails[len(mails)-1].Data["token"]
	if newToken == oldToken || mails[len(mails)-1].To != "r@example.com" {
		t.Fatalf("resent email = %+v", mails[len(mails)-1])
	}
	if n := f.count(t, `SELECT count(*) FROM invitations WHERE id = $1 AND token_hash = $2`, inv.ID, orgs.HashInvitationToken(newToken.(string))); n != 1 {
		t.Fatal("token not rotated")
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'invitation.sent' AND actor_user_id = $1 AND (metadata->>'resent')::boolean`, admin); n != 1 {
		t.Fatalf("resent audit events = %d", n)
	}

	// The resend restarts the cooldown.
	if resp := resend(owner, "acme", inv.ID); resp.Code != http.StatusTooManyRequests {
		t.Fatalf("second resend: %d %s", resp.Code, resp.Body)
	}

	expectProblem(t, "member resends", resend(member, "acme", inv.ID), http.StatusForbidden, "forbidden")
	expectProblem(t, "other org", resend(owner, "other", inv.ID), http.StatusGone, "invite_expired")
	expectProblem(t, "unknown id", resend(owner, "acme", uuid.NewString()), http.StatusGone, "invite_expired")
	if _, err := f.pool.Exec(f.ctx, `UPDATE invitations SET revoked_at = now() WHERE id = $1`, inv.ID); err != nil {
		t.Fatal(err)
	}
	expectProblem(t, "revoked", resend(owner, "acme", inv.ID), http.StatusGone, "invite_expired")
}

func TestRevokeInvitation(t *testing.T) {
	f := setupInvitations(t)
	owner := f.user(t, "rv-owner@example.com")
	admin := f.user(t, "rv-admin@example.com")
	viewer := f.user(t, "rv-viewer@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreate(t, owner, "Other", "other")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", viewer, "viewer")
	resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(owner), invite("v@example.com", "member"))
	if resp.Code != http.StatusOK {
		t.Fatalf("invite: %d %s", resp.Code, resp.Body)
	}
	id := decode[inviteResponse](t, resp).Results[0].Invitation.ID
	revoke := func(caller uuid.UUID, slug, id string) *httptest.ResponseRecorder {
		return f.api.Delete(invitationPath(slug, id, ""), as(caller))
	}

	expectProblem(t, "viewer revokes", revoke(viewer, "acme", id), http.StatusForbidden, "forbidden")
	expectProblem(t, "other org", revoke(owner, "other", id), http.StatusGone, "invite_expired")
	if resp := revoke(admin, "acme", id); resp.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM invitations WHERE id = $1 AND revoked_at IS NOT NULL`, id); n != 1 {
		t.Fatal("not revoked")
	}
	if list := decode[[]Invitation](t, f.api.Get(orgPath(InvitationsPath, "acme"), as(owner))); len(list) != 0 {
		t.Fatalf("pending after revoke = %+v", list)
	}
	expectProblem(t, "revoke twice", revoke(owner, "acme", id), http.StatusGone, "invite_expired")
}
