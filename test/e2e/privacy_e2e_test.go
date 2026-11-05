//go:build e2e

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// The PII the privacy test seeds sits under names no built-in pattern (SDK
// or server) matches, so only the configured patterns can mask it.
const (
	piiQueryParam = "e2e_pii"   // ?e2e_pii=... on the request URL
	piiHeader     = "x-e2e-pii" // request header
	piiBodyField  = "e2e_pii"   // top-level and nested JSON body field
	redacted      = "[redacted]"
)

// TestExamplePrivacy proves masked fields never reach ClickHouse through each
// SDK's example app (`task test:e2e:privacy` runs both modes):
//
//   - APILENS_E2E_PRIVACY=sdk: the apps run with client patterns for the
//     e2e_pii query parameter, header and body field
//     (APILENS_EXAMPLES_REDACT_*) and the project has no server-side policy
//     for them, so only the SDKs can mask.
//   - APILENS_E2E_PRIVACY=server: the apps run without those client patterns
//     (deliberately missing) and the project's server-side privacy policy
//     names them, so only the ingest edge can mask.
//
// Either way every row must carry the marker and no table may hold any of
// the seeded values. Besides the APILENS_E2E_* variables of
// ingest_e2e_test.go it needs
//
//	APILENS_E2E_EXAMPLES=http://127.0.0.1:18001,http://127.0.0.1:18002,http://127.0.0.1:18003
//	APILENS_E2E_EXAMPLE_APPS=example-fastapi,example-express,example-spring  (default; same order)
//	APILENS_E2E_MAILPIT_URL=http://127.0.0.1:8025  (signs in the seeded owner to edit the policy)
//	APILENS_E2E_PROJECT=dev, APILENS_E2E_OWNER_EMAIL=dev@example.com  (defaults, from `apilens seed`)
func TestExamplePrivacy(t *testing.T) {
	mode := os.Getenv("APILENS_E2E_PRIVACY")
	if mode == "" {
		t.Skip("APILENS_E2E_PRIVACY not set; run `task test:e2e:privacy`")
	}
	if mode != "sdk" && mode != "server" {
		t.Fatalf("APILENS_E2E_PRIVACY = %q, want sdk or server", mode)
	}
	e := loadEnv(t)
	bases := splitList(os.Getenv("APILENS_E2E_EXAMPLES"))
	if len(bases) == 0 {
		t.Fatal("APILENS_E2E_EXAMPLES not set; list the example app URLs (`task examples:up`)")
	}
	apps := splitList(envOr("APILENS_E2E_EXAMPLE_APPS", "example-fastapi,example-express,example-spring"))
	if len(apps) != len(bases) {
		t.Fatalf("APILENS_E2E_EXAMPLE_APPS has %d apps for %d APILENS_E2E_EXAMPLES URLs", len(apps), len(bases))
	}
	mailpit := strings.TrimRight(os.Getenv("APILENS_E2E_MAILPIT_URL"), "/")
	if mailpit == "" {
		t.Fatal("APILENS_E2E_MAILPIT_URL not set; the test signs in the project owner to set the privacy policy")
	}
	project := envOr("APILENS_E2E_PROJECT", "dev")
	owner := envOr("APILENS_E2E_OWNER_EMAIL", "dev@example.com")

	// 1. The server-side policy: empty in sdk mode, the e2e names in server
	// mode. App policies are cleared so the project policy alone decides.
	c := authClient{t: t, base: strings.TrimRight(e.base, "/")}
	tok := signIn(t, c, mailpit, owner)
	policy := map[string]any{}
	if mode == "server" {
		policy = map[string]any{
			"mask_query_params": []string{"^" + piiQueryParam + "$"},
			"mask_headers":      []string{"^" + piiHeader + "$"},
			"mask_body_fields":  []string{"^" + piiBodyField + "$"},
		}
	}
	policyPath := "/api/v1/projects/" + url.PathEscape(project) + "/privacy-policy"
	c.mustJSON(http.MethodPut, policyPath, tok, policy, http.StatusOK, nil)
	for _, app := range apps {
		c.mustJSON(http.MethodPut, policyPath+"?"+url.Values{"app": {app}}.Encode(), tok, map[string]any{}, http.StatusOK, nil)
	}

	// 2. Edges cache policies per app for ingest.app_cache_ttl; a canary
	// record sent straight to the ingest API shows when each app's cached
	// policy is the one just saved.
	run := fmt.Sprintf("e2epriv%d", time.Now().UnixNano())
	for _, app := range apps {
		e.awaitPolicy(t, run, app, mode == "server")
	}

	// 3. Seed the PII through every example app: query parameter, header,
	// top-level and nested body field in one request each.
	type seeded struct {
		app, tag                    string
		query, header, body, nested string
	}
	var sent []seeded
	client := &http.Client{Timeout: 15 * time.Second}
	for i, base := range bases {
		s := seeded{app: apps[i], tag: fmt.Sprintf("%sa%d", run, i)}
		s.query, s.header, s.body, s.nested = "pii-"+s.tag+"-query", "pii-"+s.tag+"-header", "pii-"+s.tag+"-body", "pii-"+s.tag+"-nested"
		payload, _ := json.Marshal(map[string]any{
			"item": s.tag, "quantity": 1, piiBodyField: s.body,
			"customer": map[string]any{piiBodyField: s.nested},
		})
		u := base + "/orders?" + "e2e_run=" + s.tag + "&" + piiQueryParam + "=" + s.query
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, u, strings.NewReader(string(payload)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(piiHeader, s.header)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", u, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("POST %s (%s): status %d, want 201", u, s.app, resp.StatusCode)
		}
		sent = append(sent, s)
	}

	// 4. Each request arrives with markers where the PII was and the other
	// values kept.
	for _, s := range sent {
		where := fmt.Sprintf("FROM api_requests WHERE position(raw_path, 'e2e_run=%s&') > 0", s.tag)
		e.eventually(t, s.app+" request row", "SELECT count() "+where, 1)
		checks := map[string]string{
			"query parameter masked": fmt.Sprintf("position(raw_path, '%s=%s') > 0", piiQueryParam, redacted),
			"header masked": fmt.Sprintf("arrayExists(kv -> lower(kv.1) = '%s' AND kv.2 = '%s', JSONExtractKeysAndValues(request_headers, 'String'))",
				piiHeader, redacted),
			"body field masked":        fmt.Sprintf("JSONExtractString(request_payload, '%s') = '%s'", piiBodyField, redacted),
			"nested body field masked": fmt.Sprintf("JSONExtractString(request_payload, 'customer', '%s') = '%s'", piiBodyField, redacted),
			"other body field kept":    fmt.Sprintf("JSONExtractString(request_payload, 'item') = '%s'", s.tag),
		}
		for what, cond := range checks {
			if n := e.count(t, "SELECT count() "+where+" AND "+cond); n != 1 {
				t.Errorf("%s (%s mode): %s: %d rows match %s", s.app, mode, what, n, cond)
			}
		}
	}

	// 5. No table holds any seeded value, in any column. Spans and logs may
	// trail the request rows, so look a few times before passing.
	var values []string
	from := map[string]string{}
	for _, s := range sent {
		for _, pii := range []string{s.query, s.header, s.body, s.nested} {
			values = append(values, "'"+pii+"'")
			from[pii] = s.app
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, table := range []string{"api_requests", "api_logs", "api_spans"} {
			rows := fmt.Sprintf("FROM %s WHERE timestamp > now() - INTERVAL 1 HOUR AND ", table)
			if e.count(t, "SELECT count() "+rows+"multiSearchAny(formatRowNoNewline('TabSeparated', *), ["+strings.Join(values, ",")+"])") == 0 {
				continue
			}
			for pii, app := range from {
				if n := e.count(t, "SELECT count() "+rows+"position(formatRowNoNewline('TabSeparated', *), '"+pii+"') > 0"); n > 0 {
					t.Errorf("LEAK (%s mode): %d %s rows hold the value %q seeded through %s", mode, n, table, pii, app)
				}
			}
			t.FailNow()
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(time.Second)
	}
}

// awaitPolicy sends canary records for app straight to the ingest API until
// one is stored the way the policy just saved says: masked by the server
// (wantMasked) or kept as sent. The SDKs are not involved, so this only
// observes the edge's cached policy.
func (e env) awaitPolicy(t *testing.T, run, app string, wantMasked bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for i := 0; ; i++ {
		tag := fmt.Sprintf("%scanary%s%d", run, app, i)
		value := "canary-" + tag
		if code, body := e.post(t, "/v1/requests", e.key, map[string]any{"requests": []map[string]any{{
			"app_id": app, "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "environment": "e2e",
			"method": "POST", "path": "/e2e-privacy-canary", "raw_path": "/e2e-privacy-canary?e2e_run=" + tag + "&",
			"status_code": 204, "response_time_ms": 1,
			"request_payload": fmt.Sprintf(`{"%s":%q}`, piiBodyField, value),
		}}}); code != http.StatusOK {
			t.Fatalf("canary for %s: /v1/requests = %d %s", app, code, body)
		}
		where := fmt.Sprintf("FROM api_requests WHERE path = '/e2e-privacy-canary' AND position(raw_path, 'e2e_run=%s&') > 0", tag)
		e.eventually(t, "canary row for "+app, "SELECT count() "+where, 1)
		want := value
		if wantMasked {
			want = redacted
		}
		if e.count(t, fmt.Sprintf("SELECT count() %s AND JSONExtractString(request_payload, '%s') = '%s'", where, piiBodyField, want)) == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("app %s: the edge still applies the previous privacy policy after 3m (masked wanted: %v)", app, wantMasked)
		}
		time.Sleep(3 * time.Second)
	}
}

// signIn signs in an existing user with the emailed code and returns the
// access token. Only an email that arrives after the request counts, so an
// older sign-in code to the same address is never reused.
func signIn(t *testing.T, c authClient, mailpit, email string) string {
	t.Helper()
	seen := map[string]bool{}
	for _, m := range mailpitMessages(t, mailpit, email) {
		seen[m.ID] = true
	}
	c.mustJSON(http.MethodPost, "/api/v1/auth/email/start", "", map[string]any{"email": email, "intent": "signin"}, http.StatusOK, nil)
	deadline := time.Now().Add(20 * time.Second)
	code := ""
	for code == "" {
		for _, m := range mailpitMessages(t, mailpit, email) {
			if d := sixDigits.FindStringSubmatch(m.Subject); d != nil && !seen[m.ID] {
				code = d[1]
				break
			}
		}
		if code == "" {
			if time.Now().After(deadline) {
				t.Fatalf("no new sign-in email to %s in Mailpit", email)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	var session struct {
		Status      string `json:"status"`
		AccessToken string `json:"access_token"`
	}
	c.mustJSON(http.MethodPost, "/api/v1/auth/email/verify", "", map[string]any{"email": email, "code": code}, http.StatusOK, &session)
	if session.AccessToken == "" {
		t.Fatalf("sign in %s: status %q, no access token", email, session.Status)
	}
	return session.AccessToken
}

type mailpitMessage struct {
	ID      string `json:"ID"`
	Subject string `json:"Subject"`
}

func mailpitMessages(t *testing.T, mailpit, to string) []mailpitMessage {
	t.Helper()
	u := mailpit + "/api/v1/search?" + url.Values{"query": {`to:"` + to + `"`}}.Encode()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("mailpit: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var list struct {
		Messages []mailpitMessage `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("mailpit search = %d (%v)", resp.StatusCode, err)
	}
	return list.Messages
}

func splitList(s string) []string {
	var out []string
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimRight(strings.TrimSpace(v), "/"); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
