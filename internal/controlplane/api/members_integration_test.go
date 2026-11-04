//go:build integration

package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/platform/ratelimit"
)

func memberPath(slug string, user uuid.UUID) string {
	return strings.Replace(MembersPath, "{slug}", slug, 1) + "/" + user.String()
}

func orgPath(tmpl, slug string) string { return strings.Replace(tmpl, "{slug}", slug, 1) }

// role returns user's role in the organization slug, or "" when not a member.
func (f *orgsFixture) role(t *testing.T, slug string, user uuid.UUID) string {
	t.Helper()
	var role string
	err := f.pool.QueryRow(f.ctx, `SELECT coalesce((SELECT m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.slug = $1 AND o.deleted_at IS NULL AND m.user_id = $2), '')`, slug, user).Scan(&role)
	if err != nil {
		t.Fatal(err)
	}
	return role
}

// expectProblem requires resp to be the problem status/code.
func expectProblem(t *testing.T, name string, resp *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if p := decode[problem](t, resp); resp.Code != status || p.Code != code {
		t.Errorf("%s: %d %s, want %d %s", name, resp.Code, resp.Body, status, code)
	}
}

func TestListMembers(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "lm-owner@example.com")
	admin := f.user(t, "lm-admin@example.com")
	viewer := f.user(t, "lm-viewer@example.com")
	gone := f.user(t, "lm-gone@example.com")
	stranger := f.user(t, "lm-stranger@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", viewer, "viewer")
	f.join(t, "acme", gone, "member")
	login := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET last_login_at = $2 WHERE id = $1`, admin, login); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, gone); err != nil {
		t.Fatal(err)
	}

	// Any member, even a viewer, may list; deleted accounts are left out.
	resp := f.api.Get(orgPath(MembersPath, "acme"), as(viewer))
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	list := decode[[]Member](t, resp)
	if len(list) != 3 {
		t.Fatalf("members = %+v", list)
	}
	byID := map[string]Member{}
	for _, m := range list {
		byID[m.User.ID] = m
	}
	if m := byID[owner.String()]; m.Role != "owner" || m.User.Email != "lm-owner@example.com" || m.User.Name != "Ada" || m.JoinedAt.IsZero() || m.LastLoginAt != nil {
		t.Fatalf("owner = %+v", m)
	}
	if m := byID[admin.String()]; m.Role != "admin" || m.LastLoginAt == nil || !m.LastLoginAt.Equal(login) {
		t.Fatalf("admin = %+v", m)
	}
	if m := byID[viewer.String()]; m.Role != "viewer" {
		t.Fatalf("viewer = %+v", m)
	}
	if !strings.Contains(resp.Body.String(), `"last_login_at":null`) {
		t.Fatalf("last_login_at not null for a member who never signed in: %s", resp.Body)
	}

	a, b := f.api.Get(orgPath(MembersPath, "acme"), as(stranger)), f.api.Get(orgPath(MembersPath, "missing"), as(stranger))
	if a.Code != http.StatusForbidden || a.Body.String() != b.Body.String() {
		t.Fatalf("stranger: %d %s / %d %s", a.Code, a.Body, b.Code, b.Body)
	}
}

func TestChangeMemberRole(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "cr-owner@example.com")
	admin := f.user(t, "cr-admin@example.com")
	member := f.user(t, "cr-member@example.com")
	viewer := f.user(t, "cr-viewer@example.com")
	stranger := f.user(t, "cr-stranger@example.com")
	org := f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")
	patch := func(caller, target uuid.UUID, role string) *httptest.ResponseRecorder {
		return f.api.Patch(memberPath("acme", target), as(caller), map[string]any{"role": role})
	}

	// An admin changes a member's role: membership.upserted and
	// member.role_changed in the same transaction.
	resp := patch(admin, member, "viewer")
	if resp.Code != http.StatusOK {
		t.Fatalf("admin demote: %d %s", resp.Code, resp.Body)
	}
	if m := decode[Member](t, resp); m.Role != "viewer" || m.User.ID != member.String() {
		t.Fatalf("member = %+v", m)
	}
	var payload map[string]string
	if err := f.pool.QueryRow(f.ctx, `SELECT payload FROM outbox WHERE topic = 'membership.upserted' AND payload->>'user_id' = $1`, member.String()).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["org_id"] != org.ID || payload["role"] != "viewer" {
		t.Fatalf("outbox payload = %v", payload)
	}
	var meta map[string]any
	if err := f.pool.QueryRow(f.ctx, `SELECT metadata FROM audit_events WHERE event = 'member.role_changed' AND user_id = $1 AND actor_user_id = $2`, member, admin).Scan(&meta); err != nil {
		t.Fatal(err)
	}
	if meta["from"] != "member" || meta["to"] != "viewer" || meta["org_id"] != org.ID {
		t.Fatalf("audit meta = %v", meta)
	}

	// Setting the current role changes nothing.
	before := f.count(t, `SELECT count(*) FROM outbox`)
	if resp := patch(admin, member, "viewer"); resp.Code != http.StatusOK {
		t.Fatalf("no-op: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM outbox`); n != before {
		t.Fatalf("no-op emitted %d outbox rows", n-before)
	}

	for _, tc := range []struct {
		name           string
		caller, target uuid.UUID
		role           string
		status         int
		code           string
	}{
		{"member changes a role", viewer, member, "member", http.StatusForbidden, "forbidden"},
		{"stranger", stranger, member, "member", http.StatusForbidden, "forbidden"},
		{"admin grants owner", admin, member, "owner", http.StatusForbidden, "forbidden"},
		{"admin demotes owner", admin, owner, "admin", http.StatusForbidden, "forbidden"},
		{"not a member", owner, stranger, "member", http.StatusGone, "member_gone"},
		{"last owner demotes self", owner, owner, "admin", http.StatusConflict, "last_owner"},
	} {
		before := f.count(t, `SELECT count(*) FROM outbox`)
		expectProblem(t, tc.name, patch(tc.caller, tc.target, tc.role), tc.status, tc.code)
		if n := f.count(t, `SELECT count(*) FROM outbox`); n != before {
			t.Errorf("%s: refused change emitted outbox rows", tc.name)
		}
	}
	if resp := patch(owner, member, "superuser"); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("unknown role: %d", resp.Code)
	}
	if f.role(t, "acme", owner) != "owner" || f.role(t, "acme", member) != "viewer" {
		t.Fatal("refused changes changed roles")
	}

	// Only an owner grants owner; with two owners one may step down.
	if resp := patch(owner, admin, "owner"); resp.Code != http.StatusOK {
		t.Fatalf("owner grants owner: %d %s", resp.Code, resp.Body)
	}
	if resp := patch(admin, owner, "member"); resp.Code != http.StatusOK {
		t.Fatalf("owner demotes owner: %d %s", resp.Code, resp.Body)
	}
	expectProblem(t, "new last owner demotes self", patch(admin, admin, "viewer"), http.StatusConflict, "last_owner")
	if f.role(t, "acme", admin) != "owner" || f.role(t, "acme", owner) != "member" {
		t.Fatalf("roles = %s / %s", f.role(t, "acme", admin), f.role(t, "acme", owner))
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'member.role_changed'`); n != 3 {
		t.Fatalf("member.role_changed events = %d, want 3", n)
	}
}

func TestRemoveMember(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "rm-owner@example.com")
	owner2 := f.user(t, "rm-owner2@example.com")
	admin := f.user(t, "rm-admin@example.com")
	member := f.user(t, "rm-member@example.com")
	viewer := f.user(t, "rm-viewer@example.com")
	stranger := f.user(t, "rm-stranger@example.com")
	org := f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")
	del := func(caller, target uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Delete(memberPath("acme", target), as(caller))
	}

	expectProblem(t, "member removes", del(member, viewer), http.StatusForbidden, "forbidden")
	expectProblem(t, "stranger removes", del(stranger, viewer), http.StatusForbidden, "forbidden")
	expectProblem(t, "admin removes owner", del(admin, owner), http.StatusForbidden, "forbidden")
	expectProblem(t, "not a member", del(admin, stranger), http.StatusGone, "member_gone")
	expectProblem(t, "last owner removes self", del(owner, owner), http.StatusConflict, "last_owner")
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'membership.deleted'`); n != 0 {
		t.Fatalf("refused removals emitted %d outbox rows", n)
	}

	resp := del(admin, viewer)
	if resp.Code != http.StatusNoContent {
		t.Fatalf("admin removes viewer: %d %s", resp.Code, resp.Body)
	}
	if f.role(t, "acme", viewer) != "" {
		t.Fatal("viewer is still a member")
	}
	var aggregate string
	var payload map[string]string
	if err := f.pool.QueryRow(f.ctx, `SELECT aggregate_id, payload FROM outbox WHERE topic = 'membership.deleted'`).Scan(&aggregate, &payload); err != nil {
		t.Fatal(err)
	}
	if aggregate != org.ID || payload["org_id"] != org.ID || payload["user_id"] != viewer.String() {
		t.Fatalf("outbox = %s %v", aggregate, payload)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'member.removed' AND user_id = $1 AND actor_user_id = $2 AND metadata->>'left' = 'false'`, viewer, admin); n != 1 {
		t.Fatalf("member.removed events = %d", n)
	}
	expectProblem(t, "removed twice", del(admin, viewer), http.StatusGone, "member_gone")

	// The removed member loses access.
	if resp := f.api.Get(orgPath(MembersPath, "acme"), as(viewer)); resp.Code != http.StatusForbidden {
		t.Fatalf("removed member lists: %d", resp.Code)
	}

	// An owner may remove another owner while one remains.
	f.join(t, "acme", owner2, "owner")
	if resp := del(owner2, owner); resp.Code != http.StatusNoContent {
		t.Fatalf("owner removes owner: %d %s", resp.Code, resp.Body)
	}
	expectProblem(t, "remaining owner removes self", del(owner2, owner2), http.StatusConflict, "last_owner")
}

func TestLeaveOrg(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "lv-owner@example.com")
	viewer := f.user(t, "lv-viewer@example.com")
	stranger := f.user(t, "lv-stranger@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", viewer, "viewer")
	leave := func(u uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Post(orgPath(LeaveOrgPath, "acme"), as(u), map[string]any{})
	}

	if resp := leave(viewer); resp.Code != http.StatusNoContent {
		t.Fatalf("viewer leaves: %d %s", resp.Code, resp.Body)
	}
	if f.role(t, "acme", viewer) != "" {
		t.Fatal("viewer is still a member")
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'membership.deleted' AND payload->>'user_id' = $1`, viewer.String()); n != 1 {
		t.Fatalf("membership.deleted rows = %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'member.removed' AND user_id = $1 AND actor_user_id = $1 AND metadata->>'left' = 'true'`, viewer); n != 1 {
		t.Fatalf("member.removed events = %d", n)
	}
	expectProblem(t, "left twice", leave(viewer), http.StatusForbidden, "forbidden")
	expectProblem(t, "stranger", leave(stranger), http.StatusForbidden, "forbidden")
	expectProblem(t, "last owner", leave(owner), http.StatusConflict, "last_owner")

	// With a second owner the first may leave.
	f.join(t, "acme", viewer, "owner")
	if resp := leave(owner); resp.Code != http.StatusNoContent {
		t.Fatalf("owner leaves: %d %s", resp.Code, resp.Body)
	}
	if f.role(t, "acme", owner) != "" || f.role(t, "acme", viewer) != "owner" {
		t.Fatal("leave did not take effect")
	}
}

func TestTransferOwnership(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "tr-owner@example.com")
	admin := f.user(t, "tr-admin@example.com")
	member := f.user(t, "tr-member@example.com")
	stranger := f.user(t, "tr-stranger@example.com")
	org := f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	transfer := func(caller, target uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Post(orgPath(TransferOwnershipPath, "acme"), as(caller), map[string]any{"user_id": target.String()})
	}

	expectProblem(t, "admin transfers", transfer(admin, member), http.StatusForbidden, "forbidden")
	expectProblem(t, "stranger transfers", transfer(stranger, member), http.StatusForbidden, "forbidden")
	expectProblem(t, "to a non-member", transfer(owner, stranger), http.StatusGone, "member_gone")
	expectProblem(t, "to self", transfer(owner, owner), http.StatusBadRequest, "invalid_request")
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'membership.upserted'`); n != 0 {
		t.Fatalf("refused transfers emitted %d outbox rows", n)
	}

	if resp := transfer(owner, member); resp.Code != http.StatusNoContent {
		t.Fatalf("transfer: %d %s", resp.Code, resp.Body)
	}
	if f.role(t, "acme", member) != "owner" || f.role(t, "acme", owner) != "admin" {
		t.Fatalf("roles = %s / %s", f.role(t, "acme", member), f.role(t, "acme", owner))
	}
	rows, err := f.pool.Query(f.ctx, `SELECT aggregate_id, payload->>'user_id', payload->>'role' FROM outbox WHERE topic = 'membership.upserted' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var agg, user, role string
		if err := rows.Scan(&agg, &user, &role); err != nil {
			t.Fatal(err)
		}
		if agg != org.ID {
			t.Fatalf("aggregate = %s", agg)
		}
		got = append(got, user+"="+role)
	}
	rows.Close()
	if want := []string{member.String() + "=owner", owner.String() + "=admin"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("outbox = %v, want %v", got, want)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'member.role_changed' AND actor_user_id = $1`, owner); n != 2 {
		t.Fatalf("member.role_changed events = %d, want 2", n)
	}

	// The former owner is now an admin and can no longer transfer.
	expectProblem(t, "former owner transfers", transfer(owner, admin), http.StatusForbidden, "forbidden")
	expectProblem(t, "new owner leaves", f.api.Post(orgPath(LeaveOrgPath, "acme"), as(member), map[string]any{}), http.StatusConflict, "last_owner")
}
