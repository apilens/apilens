//go:build e2e

// The user journey over HTTP only, against the compose stack with
// compose.ci.yaml (SMTP to Mailpit):
//
//	email start → code from Mailpit → verify → create org, project, API key
//	→ ingest with that key → query the event back with the user's session.
//
//	APILENS_E2E_BASE_URL=http://localhost:8080
//	APILENS_E2E_MAILPIT_URL=http://localhost:8025   (Mailpit HTTP API/UI)
//
// Addresses are unique @example.com ones; mail only ever reaches Mailpit.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// authClient calls the APILens HTTP API, optionally with a bearer token.
type authClient struct {
	t    *testing.T
	base string
}

// do sends method path with body (JSON-encoded unless nil) and returns the
// status and response body.
func (c authClient) do(method, path, bearer string, body any) (int, []byte) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		c.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatalf("%s %s: read body: %v", method, path, err)
	}
	return resp.StatusCode, out
}

// mustJSON sends the request, requires status want and decodes the body
// into out (when non-nil).
func (c authClient) mustJSON(method, path, bearer string, body any, want int, out any) {
	c.t.Helper()
	code, b := c.do(method, path, bearer, body)
	if code != want {
		c.t.Fatalf("%s %s = %d, want %d: %s", method, path, code, want, b)
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			c.t.Fatalf("%s %s: decode %s: %v", method, path, b, err)
		}
	}
}

var sixDigits = regexp.MustCompile(`\b(\d{6})\b`)

// mailpitCode waits for the sign-in email to `to` in Mailpit and returns the
// 6-digit code from its subject ("Your APILens sign-in code is 123456").
func mailpitCode(t *testing.T, mailpit, to string) string {
	t.Helper()
	u := mailpit + "/api/v1/search?" + url.Values{"query": {`to:"` + to + `"`}}.Encode()
	deadline := time.Now().Add(20 * time.Second)
	for {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("mailpit: %v", err)
		}
		var list struct {
			Messages []struct {
				Subject string `json:"Subject"`
			} `json:"messages"`
		}
		status := resp.StatusCode
		err = json.NewDecoder(resp.Body).Decode(&list)
		_ = resp.Body.Close()
		if status != http.StatusOK || err != nil {
			t.Fatalf("mailpit search = %d (%v)", status, err)
		}
		for _, m := range list.Messages {
			if c := sixDigits.FindStringSubmatch(m.Subject); c != nil {
				return c[1]
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no sign-in email to %s in Mailpit (%d messages)", to, len(list.Messages))
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func TestAuthEndToEnd(t *testing.T) {
	base, mailpit := os.Getenv("APILENS_E2E_BASE_URL"), strings.TrimRight(os.Getenv("APILENS_E2E_MAILPIT_URL"), "/")
	if base == "" || mailpit == "" {
		t.Skip("APILENS_E2E_BASE_URL / APILENS_E2E_MAILPIT_URL not set; run via `task test:e2e` against a running stack (compose.ci.yaml)")
	}
	c := authClient{t: t, base: strings.TrimRight(base, "/")}
	run := fmt.Sprintf("e2e%d", time.Now().UnixNano())
	email := run + "@example.com"

	// 1. Sign up with the emailed code.
	var started struct {
		Sent bool `json:"sent"`
	}
	c.mustJSON(http.MethodPost, "/api/v1/auth/email/start", "", map[string]any{"email": email, "intent": "signup"}, http.StatusOK, &started)
	if !started.Sent {
		t.Fatal("email start: sent = false")
	}
	code := mailpitCode(t, mailpit, email)
	var session struct {
		Status      string `json:"status"`
		AccessToken string `json:"access_token"`
		User        struct {
			Email string `json:"email"`
		} `json:"user"`
	}
	c.mustJSON(http.MethodPost, "/api/v1/auth/email/verify", "", map[string]any{"email": email, "code": code}, http.StatusOK, &session)
	if session.AccessToken == "" || session.Status != "" {
		t.Fatalf("verify: status %q, access token set %v", session.Status, session.AccessToken != "")
	}
	if !strings.EqualFold(session.User.Email, email) {
		t.Fatalf("verify: user email %q, want %q", session.User.Email, email)
	}
	tok := session.AccessToken

	// 2. Organization, project and an ingest + read key, as that user.
	var org struct {
		Slug string `json:"slug"`
		Role string `json:"role"`
	}
	c.mustJSON(http.MethodPost, "/api/v1/orgs", tok, map[string]any{"name": "E2E " + run, "slug": run}, http.StatusCreated, &org)
	if org.Slug != run || org.Role != "owner" {
		t.Fatalf("create org = %+v", org)
	}
	var project struct {
		Slug    string `json:"slug"`
		OrgSlug string `json:"org_slug"`
	}
	// The owner's roles reach SpiceDB through the relay, so the creates
	// below may answer 403/404 for a moment.
	createWhenGranted(t, c, "/api/v1/orgs/"+run+"/projects", tok,
		map[string]any{"name": "E2E " + run, "slug": run, "environments": []string{"e2e"}}, &project)
	if project.Slug != run || project.OrgSlug != run {
		t.Fatalf("create project = %+v", project)
	}
	var key struct {
		Key    string   `json:"key"`
		Scopes []string `json:"scopes"`
	}
	createWhenGranted(t, c, "/api/v1/projects/"+run+"/api-keys", tok,
		map[string]any{"name": "e2e", "scopes": []string{"ingest"}}, &key)
	if key.Key == "" {
		t.Fatal("create api key: no key in response")
	}

	// 3. Ingest with the new key. Deploy markers are project-wide (no app
	// needed); the release is unique to this run.
	ingest := func() (int, []byte) {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, c.base+"/v1/deploys",
			strings.NewReader(fmt.Sprintf(`{"deploys":[{"release":%q,"environment":"e2e","commit":"abc1234"}]}`, run)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", key.Key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST /v1/deploys: %v", err)
		}
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	if code, body := ingest(); code != http.StatusOK || !strings.Contains(string(body), `"accepted":1`) {
		t.Fatalf("POST /v1/deploys = %d %s", code, body)
	}

	// 4. The session sees the event on the dashboard API. Grants reach the
	// authorization store asynchronously and the sink batches, so poll.
	deploysPath := "/api/v1/deploys?" + url.Values{"project": {run}, "range": {"1h"}, "env": {"e2e"}}.Encode()
	deadline := time.Now().Add(30 * time.Second)
	for {
		status, body := c.do(http.MethodGet, deploysPath, tok, nil)
		if status == http.StatusOK {
			var out struct {
				Deploys []struct {
					Release string `json:"release"`
				} `json:"deploys"`
			}
			if err := json.Unmarshal(body, &out); err != nil {
				t.Fatalf("deploys: decode %s: %v", body, err)
			}
			if len(out.Deploys) == 1 && out.Deploys[0].Release == run {
				break
			}
			if len(out.Deploys) > 1 {
				t.Fatalf("deploys = %s, want only this run's", body)
			}
		} else if status != http.StatusNotFound {
			// 404 is expected only until the owner grant is visible.
			t.Fatalf("GET %s = %d %s", deploysPath, status, body)
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET %s: release %s not visible after 30s (last %d %s)", deploysPath, run, status, body)
		}
		time.Sleep(250 * time.Millisecond)
	}

	// 5. The query API stays scoped: a session must name the project, cannot
	// see a project it is not a member of, and the ingest key cannot query.
	if status, body := c.do(http.MethodGet, "/api/v1/deploys?range=1h", tok, nil); status != http.StatusUnprocessableEntity {
		t.Fatalf("session without ?project= = %d %s, want 422", status, body)
	}
	if status, body := c.do(http.MethodGet, "/api/v1/deploys?range=1h&project="+run+"-missing", tok, nil); status != http.StatusNotFound {
		t.Fatalf("session on an unknown project = %d %s, want 404", status, body)
	}
	if status, body := c.do(http.MethodGet, deploysPath, key.Key, nil); status != http.StatusForbidden {
		t.Fatalf("ingest key on the query API = %d %s, want 403", status, body)
	}
	if status, body := c.do(http.MethodGet, deploysPath, "", nil); status != http.StatusUnauthorized {
		t.Fatalf("anonymous query = %d %s, want 401", status, body)
	}
}
