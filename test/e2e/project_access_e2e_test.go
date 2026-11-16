//go:build e2e

// Project access over HTTP only, against the compose stack with
// compose.ci.yaml (SMTP to Mailpit), so every change goes through the
// outbox and the relay to SpiceDB before the next permission check:
//
//	owner creates org + project → invites a member (Mailpit link) → member
//	signs up and accepts → owner restricts the project (default access none)
//	→ member loses the project, its keys and the query API → owner grants
//	viewer, editor, admin (one representative operation each) → owner
//	removes the member from the org → the direct grant is gone, also after
//	they rejoin.
//
// Every change must be visible to the member within accessPropagation.
//
//	APILENS_E2E_BASE_URL=http://localhost:8080
//	APILENS_E2E_MAILPIT_URL=http://localhost:8025
//
// Addresses are unique @example.com ones; mail only ever reaches Mailpit.
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// accessPropagation is how long a project access change may take to reach
// every permission check (outbox → relay → SpiceDB).
const accessPropagation = 5 * time.Second

// within polls cond until it reports true and fails the test when that
// takes longer than accessPropagation. cond returns a description of the
// last observation for the failure message.
func within(t *testing.T, what string, cond func() (bool, string)) {
	t.Helper()
	start := time.Now()
	deadline := start.Add(accessPropagation)
	for {
		ok, last := cond()
		if ok {
			t.Logf("%s: effective after %s", what, time.Since(start).Round(time.Millisecond))
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: not effective within %s (last: %s)", what, accessPropagation, last)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// statusIs returns a within condition that holds when method path (as
// bearer, with body) answers want.
func statusIs(c authClient, method, path, bearer string, body any, want int) func() (bool, string) {
	return func() (bool, string) {
		code, b := c.do(method, path, bearer, body)
		return code == want, fmt.Sprintf("%s %s = %d %s", method, path, code, b)
	}
}

// createWhenGranted POSTs body to path until it answers 201 (a refused
// create changes nothing) and decodes the response into out. It is for a
// create right after the caller got the role it needs: that role reaches
// SpiceDB through the relay, so the first attempts may answer 403 or 404.
func createWhenGranted(t *testing.T, c authClient, path, bearer string, body, out any) {
	t.Helper()
	var created []byte
	within(t, "POST "+path, func() (bool, string) {
		code, b := c.do(http.MethodPost, path, bearer, body)
		created = b
		return code == http.StatusCreated, fmt.Sprintf("POST %s = %d %s", path, code, b)
	})
	if out != nil {
		if err := json.Unmarshal(created, out); err != nil {
			t.Fatalf("POST %s: decode %s: %v", path, created, err)
		}
	}
}

var inviteLink = regexp.MustCompile(`/invite/([A-Za-z0-9_-]+)`)

// mailpitInviteToken waits for an invitation email to `to` in Mailpit
// whose token is not in seen and returns that token.
func mailpitInviteToken(t *testing.T, mailpit, to string, seen map[string]bool) string {
	t.Helper()
	getJSON := func(u string, out any) {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("mailpit: %v", err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("mailpit GET %s = %d", u, resp.StatusCode)
		}
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("mailpit GET %s: %v", u, err)
		}
	}
	search := mailpit + "/api/v1/search?" + url.Values{"query": {`to:"` + to + `"`}}.Encode()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var list struct {
			Messages []struct {
				ID string `json:"ID"`
			} `json:"messages"`
		}
		getJSON(search, &list)
		for _, m := range list.Messages {
			var msg struct {
				Text string `json:"Text"`
			}
			getJSON(mailpit+"/api/v1/message/"+url.PathEscape(m.ID), &msg)
			if tok := inviteLink.FindStringSubmatch(msg.Text); tok != nil && !seen[tok[1]] {
				seen[tok[1]] = true
				return tok[1]
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no new invitation email to %s in Mailpit (%d messages)", to, len(list.Messages))
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// signUp signs email up with the code from Mailpit and returns the access
// token and the user id.
func signUp(t *testing.T, c authClient, mailpit, email string) (string, string) {
	t.Helper()
	c.mustJSON(http.MethodPost, "/api/v1/auth/email/start", "", map[string]any{"email": email, "intent": "signup"}, http.StatusOK, nil)
	code := mailpitCode(t, mailpit, email)
	var session struct {
		AccessToken string `json:"access_token"`
		User        struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	c.mustJSON(http.MethodPost, "/api/v1/auth/email/verify", "", map[string]any{"email": email, "code": code}, http.StatusOK, &session)
	if session.AccessToken == "" || session.User.ID == "" {
		t.Fatalf("verify %s: no access token or user id", email)
	}
	return session.AccessToken, session.User.ID
}

func TestProjectAccessEndToEnd(t *testing.T) {
	base, mailpit := os.Getenv("APILENS_E2E_BASE_URL"), strings.TrimRight(os.Getenv("APILENS_E2E_MAILPIT_URL"), "/")
	if base == "" || mailpit == "" {
		t.Skip("APILENS_E2E_BASE_URL / APILENS_E2E_MAILPIT_URL not set; run via `task test:e2e` against a running stack (compose.ci.yaml)")
	}
	c := authClient{t: t, base: strings.TrimRight(base, "/")}
	run := fmt.Sprintf("e2e%d", time.Now().UnixNano())
	ownerEmail, memberEmail := run+"-owner@example.com", run+"-member@example.com"
	seenInvites := map[string]bool{}

	// Owner: org, project.
	owner, _ := signUp(t, c, mailpit, ownerEmail)
	c.mustJSON(http.MethodPost, "/api/v1/orgs", owner, map[string]any{"name": "E2E " + run, "slug": run}, http.StatusCreated, nil)
	createWhenGranted(t, c, "/api/v1/orgs/"+run+"/projects", owner,
		map[string]any{"name": "E2E " + run, "slug": run, "environments": []string{"e2e"}}, nil)

	// Member: signs up, then accepts an org invitation (role member).
	member, memberID := signUp(t, c, mailpit, memberEmail)
	invite := func() {
		t.Helper()
		var out struct {
			Results []struct {
				Status string `json:"status"`
			} `json:"results"`
		}
		c.mustJSON(http.MethodPost, "/api/v1/orgs/"+run+"/invitations", owner,
			map[string]any{"invites": []map[string]any{{"email": memberEmail, "role": "member"}}}, http.StatusOK, &out)
		if len(out.Results) != 1 || out.Results[0].Status != "invited" {
			t.Fatalf("invite %s = %+v", memberEmail, out.Results)
		}
		token := mailpitInviteToken(t, mailpit, memberEmail, seenInvites)
		var accepted struct {
			Joined bool `json:"joined"`
		}
		c.mustJSON(http.MethodPost, "/api/v1/auth/invitations/"+url.PathEscape(token)+"/accept", member, nil, http.StatusOK, &accepted)
		if !accepted.Joined {
			t.Fatal("accept invitation: joined = false")
		}
	}
	invite()

	projectPath := "/api/v1/projects/" + run
	keysPath := projectPath + "/api-keys"
	accessPath := projectPath + "/access"
	memberPath := projectPath + "/members/" + memberID
	queryPath := "/api/v1/deploys?" + url.Values{"project": {run}, "range": {"1h"}, "env": {"e2e"}}.Encode()
	newKey := map[string]any{"name": "e2e-member", "scopes": []string{"ingest"}}

	// role returns a within condition that holds when the member sees the
	// project with effective role want.
	role := func(want string) func() (bool, string) {
		return func() (bool, string) {
			code, b := c.do(http.MethodGet, projectPath, member, nil)
			if code != http.StatusOK {
				return false, fmt.Sprintf("GET %s = %d %s", projectPath, code, b)
			}
			var p struct {
				Role string `json:"role"`
			}
			if err := json.Unmarshal(b, &p); err != nil {
				t.Fatalf("GET %s: decode %s: %v", projectPath, b, err)
			}
			return p.Role == want, "role " + p.Role
		}
	}
	// lostAccess asserts the member cannot see the project, its keys or
	// its data: each answers 404 within accessPropagation.
	lostAccess := func(why string) {
		t.Helper()
		within(t, why+": project hidden", statusIs(c, http.MethodGet, projectPath, member, nil, http.StatusNotFound))
		within(t, why+": keys hidden", statusIs(c, http.MethodGet, keysPath, member, nil, http.StatusNotFound))
		within(t, why+": query API hidden", statusIs(c, http.MethodGet, queryPath, member, nil, http.StatusNotFound))
		within(t, why+": key create hidden", statusIs(c, http.MethodPost, keysPath, member, newKey, http.StatusNotFound))
	}

	// 1. Default access org_role: an org member is editor.
	within(t, "join org: member is editor", role("editor"))

	// 2. Restrict: the dry run counts the member and changes nothing; the
	// change takes their access away.
	var dry struct {
		DefaultAccess string `json:"default_access"`
		LoseAccess    int64  `json:"lose_access"`
		DryRun        bool   `json:"dry_run"`
	}
	c.mustJSON(http.MethodPatch, accessPath+"?dry_run=true", owner, map[string]any{"default_access": "none"}, http.StatusOK, &dry)
	if !dry.DryRun || dry.DefaultAccess != "org_role" || dry.LoseAccess != 1 {
		t.Fatalf("restrict dry run = %+v, want dry_run, default org_role, lose_access 1", dry)
	}
	if ok, last := role("editor")(); !ok {
		t.Fatalf("after the dry run the member should still be editor: %s", last)
	}
	c.mustJSON(http.MethodPatch, accessPath, owner, map[string]any{"default_access": "none"}, http.StatusOK, nil)
	lostAccess("restrict")

	// 3. Viewer: sees the project, its keys and its data; cannot create a key.
	c.mustJSON(http.MethodPut, memberPath, owner, map[string]any{"role": "viewer"}, http.StatusOK, nil)
	within(t, "grant viewer: role", role("viewer"))
	within(t, "grant viewer: keys listed", statusIs(c, http.MethodGet, keysPath, member, nil, http.StatusOK))
	within(t, "grant viewer: query API", statusIs(c, http.MethodGet, queryPath, member, nil, http.StatusOK))
	if code, b := c.do(http.MethodPost, keysPath, member, newKey); code != http.StatusForbidden {
		t.Fatalf("viewer creates a key = %d %s, want 403", code, b)
	}

	// 4. Editor: creates a key; cannot manage access.
	c.mustJSON(http.MethodPut, memberPath, owner, map[string]any{"role": "editor"}, http.StatusOK, nil)
	within(t, "grant editor: create key", statusIs(c, http.MethodPost, keysPath, member, newKey, http.StatusCreated))
	if code, b := c.do(http.MethodPatch, accessPath+"?dry_run=true", member, map[string]any{"default_access": "viewer"}); code != http.StatusForbidden {
		t.Fatalf("editor manages access = %d %s, want 403", code, b)
	}

	// 5. Admin: manages access (a dry run, so nothing changes).
	c.mustJSON(http.MethodPut, memberPath, owner, map[string]any{"role": "admin"}, http.StatusOK, nil)
	within(t, "grant admin: manage access", statusIs(c, http.MethodPatch, accessPath+"?dry_run=true", member,
		map[string]any{"default_access": "viewer"}, http.StatusOK))
	within(t, "grant admin: role", role("admin"))

	// 6. Remove from the org: every grant goes with the membership.
	if code, b := c.do(http.MethodDelete, "/api/v1/orgs/"+run+"/members/"+memberID, owner, nil); code != http.StatusNoContent {
		t.Fatalf("remove member = %d %s, want 204", code, b)
	}
	within(t, "remove from org: org hidden", statusIs(c, http.MethodGet, "/api/v1/orgs/"+run, member, nil, http.StatusNotFound))
	lostAccess("remove from org")

	// directGrant reports whether the access list shows the member with a
	// direct role.
	directGrant := func() bool {
		var page struct {
			DefaultAccess string `json:"default_access"`
			Members       []struct {
				UserID     string  `json:"user_id"`
				DirectRole *string `json:"direct_role"`
			} `json:"members"`
		}
		c.mustJSON(http.MethodGet, accessPath+"?limit=200", owner, nil, http.StatusOK, &page)
		if page.DefaultAccess != "none" {
			t.Fatalf("default access = %q, want none", page.DefaultAccess)
		}
		for _, m := range page.Members {
			if m.UserID == memberID {
				return true
			}
		}
		return false
	}
	if directGrant() {
		t.Fatal("removed member still listed on the restricted project")
	}

	// 7. Rejoin the org: the old admin grant does not come back, so the
	// restricted project stays hidden.
	invite()
	within(t, "rejoin org: org visible", statusIs(c, http.MethodGet, "/api/v1/orgs/"+run, member, nil, http.StatusOK))
	if code, b := c.do(http.MethodGet, projectPath, member, nil); code != http.StatusNotFound {
		t.Fatalf("rejoined member sees the restricted project = %d %s, want 404", code, b)
	}
	if directGrant() {
		t.Fatal("rejoined member has a direct grant again")
	}
}
