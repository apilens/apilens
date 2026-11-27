//go:build integration

package api

import (
	"net/http"
	"strings"
	"testing"
)

func acceptMyInvitationPath(id string) string {
	return strings.Replace(AcceptMyInvitationPath, "{id}", id, 1)
}

func TestMyInvitationsIntegration(t *testing.T) {
	f := setupInvitations(t)
	owner := f.namedUser(t, "mi-owner@example.com", "Ada Lovelace")
	bob := f.user(t, "mi-bob@example.com")
	carol := f.user(t, "mi-carol@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreate(t, owner, "Globex", "globex")
	f.mustCreate(t, owner, "Initech", "initech")
	f.mustCreate(t, owner, "Hooli", "hooli")

	list := func(user string) []MyInvitation {
		t.Helper()
		resp := f.api.Get(MyInvitationsPath, user)
		if resp.Code != http.StatusOK {
			t.Fatalf("list: %d %s", resp.Code, resp.Body)
		}
		return decode[[]MyInvitation](t, resp)
	}

	if resp := f.api.Get(MyInvitationsPath); resp.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous list: %d %s", resp.Code, resp.Body)
	}

	// One pending invitation to the caller's address (case-insensitive).
	f.inviteToken(t, owner, "acme", "MI-Bob@Example.com", "admin")
	got := list(as(bob))
	if len(got) != 1 || got[0].OrgSlug != "acme" || got[0].OrgName != "Acme" || got[0].Role != "admin" ||
		got[0].InvitedByName != "Ada Lovelace" || got[0].ExpiresAt.IsZero() || got[0].ID == "" {
		t.Fatalf("bob's invitations = %+v", got)
	}

	// An invitation to another address is not listed, and not acceptable.
	if l := list(as(carol)); len(l) != 0 {
		t.Fatalf("carol sees %+v", l)
	}
	if resp := f.api.Post(acceptMyInvitationPath(got[0].ID), as(carol)); resp.Code != http.StatusNotFound {
		t.Fatalf("accept someone else's: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Post(acceptMyInvitationPath("00000000-0000-0000-0000-000000000000"), as(carol)); resp.Code != http.StatusNotFound {
		t.Fatalf("accept unknown: %d %s", resp.Code, resp.Body)
	}
	if f.role(t, "acme", carol) != "" {
		t.Fatal("carol joined")
	}

	// Expired and revoked invitations are not listed.
	f.inviteToken(t, owner, "globex", "mi-bob@example.com", "member")
	f.exec(t, `UPDATE invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day' WHERE org_id = (SELECT id FROM organizations WHERE slug = 'globex')`)
	f.inviteToken(t, owner, "initech", "mi-bob@example.com", "member")
	f.exec(t, `UPDATE invitations SET revoked_at = now() WHERE org_id = (SELECT id FROM organizations WHERE slug = 'initech')`)
	if l := list(as(bob)); len(l) != 1 || l[0].OrgSlug != "acme" {
		t.Fatalf("bob's invitations = %+v", l)
	}

	// Newest first.
	f.inviteToken(t, owner, "hooli", "mi-bob@example.com", "viewer")
	if l := list(as(bob)); len(l) != 2 || l[0].OrgSlug != "hooli" || l[1].OrgSlug != "acme" {
		t.Fatalf("bob's invitations = %+v", l)
	}

	// Accepting joins with the invited role; a second accept is a 409.
	resp := f.api.Post(acceptMyInvitationPath(got[0].ID), as(bob))
	if resp.Code != http.StatusOK {
		t.Fatalf("accept: %d %s", resp.Code, resp.Body)
	}
	if org := decode[Org](t, resp); org.Slug != "acme" || org.Role != "admin" {
		t.Fatalf("accepted org = %+v", org)
	}
	if f.role(t, "acme", bob) != "admin" {
		t.Fatalf("bob's role = %q", f.role(t, "acme", bob))
	}
	if p := decode[problem](t, f.api.Post(acceptMyInvitationPath(got[0].ID), as(bob))); p.Code != "invitation_not_pending" {
		t.Fatalf("second accept: %+v", p)
	}
	if resp := f.api.Post(acceptMyInvitationPath(got[0].ID), as(bob)); resp.Code != http.StatusConflict {
		t.Fatalf("second accept status: %d %s", resp.Code, resp.Body)
	}
	if l := list(as(bob)); len(l) != 1 || l[0].OrgSlug != "hooli" {
		t.Fatalf("bob's invitations after accept = %+v", l)
	}
}
