//go:build integration

package api

import (
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/auditlog"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/testutil"
)

type auditList struct {
	Events        []AuditEvent `json:"events"`
	NextCursor    string       `json:"next_cursor"`
	RetentionDays int          `json:"retention_days"`
}

type auditFixture struct {
	*accessFixture
	// hidden is a project id of acme that the caller cannot view (it is not
	// an active project).
	hidden uuid.UUID
}

// setupAuditEvents is setupAccess with the audit endpoints and, recorded in
// one transaction (so with equal timestamps): five api_key.created events
// and an app.created by the system on shop, an org-wide member.added, and an
// api_key.created on a project of acme nobody can view.
func setupAuditEvents(t *testing.T) *auditFixture {
	t.Helper()
	f := &auditFixture{accessFixture: setupAccess(t), hidden: uuid.New()}
	logger := testutil.Logger(t)
	guard := authz.NewGuard(f.authz, authz.NewPGResolver(f.pool), authz.GuardOptions{}, logger)
	NewAuditEvents(auditlog.New(f.pool, f.authz), guard, guard, logger).WithRetention(400).Register(f.api)

	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	ctx := audit.WithTx(audit.WithRequest(f.ctx, audit.Request{UserAgent: "test-agent", ID: "req-1"}), tx)
	rec := audit.New(f.pool)
	owner := f.users["owner"]
	record := func(e audit.Event) {
		t.Helper()
		if err := rec.Record(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 5 {
		record(audit.Event{Actor: &owner, Kind: audit.APIKeyCreated, Org: &f.org, Project: &f.project,
			Target:  audit.Target{Type: "api_key", ID: strconv.Itoa(i), Label: "Key-" + strconv.Itoa(i)},
			Changes: &audit.Changes{Next: map[string]any{"name": "Key-" + strconv.Itoa(i)}}})
	}
	record(audit.Event{Kind: audit.AppCreated, Org: &f.org, Project: &f.project, Target: audit.Target{Type: "app", ID: "web", Label: "Web"}})
	record(audit.Event{Actor: &owner, Kind: audit.MemberAdded, Org: &f.org, Target: audit.Target{Type: "member", ID: f.users["member"].String(), Label: "member"}})
	record(audit.Event{Actor: &owner, Kind: audit.APIKeyCreated, Org: &f.org, Project: &f.hidden, Target: audit.Target{Type: "api_key", ID: "x", Label: "Hidden"}})
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *auditFixture) getAudit(user, path string, query url.Values) (int, string) {
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	resp := f.api.Get(path, as(f.users[user]))
	return resp.Code, resp.Body.String()
}

func (f *auditFixture) listAudit(t *testing.T, user, path string, query url.Values) auditList {
	t.Helper()
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	resp := f.api.Get(path, as(f.users[user]))
	if resp.Code != http.StatusOK {
		t.Fatalf("GET %s as %s: %d %s", path, user, resp.Code, resp.Body)
	}
	return decode[auditList](t, resp)
}

func TestProjectAuditEvents(t *testing.T) {
	f := setupAuditEvents(t)
	path := ProjectsPath + "/shop/audit-events"

	all := f.listAudit(t, "owner", path, nil)
	want := f.count(t, `SELECT count(*) FROM audit_events WHERE project_id = $1`, f.project)
	if len(all.Events) != want || want < 6 || all.NextCursor != "" {
		t.Fatalf("events = %d (want %d), next %q", len(all.Events), want, all.NextCursor)
	}
	if all.RetentionDays != 400 {
		t.Fatalf("retention_days = %d, want 400", all.RetentionDays)
	}
	for _, e := range all.Events {
		if e.Action == "api_key.created" && e.Target.Label == "Hidden" {
			t.Fatal("another project's event listed")
		}
		if e.Project != nil {
			t.Fatalf("project list names the project: %+v", e)
		}
	}
	var key audit.Kind
	for _, e := range all.Events {
		if e.Action == string(audit.APIKeyCreated) {
			key = audit.APIKeyCreated
			if e.Actor.Type != "user" || e.Actor.ID != f.users["owner"].String() || e.Actor.Label == "" ||
				e.Target == nil || e.Target.Type != "api_key" || e.UserAgent != "test-agent" || e.RequestID != "req-1" ||
				e.Changes == nil || e.Changes["next"] == nil {
				t.Fatalf("api_key.created = %+v", e)
			}
		}
		if e.Action == string(audit.AppCreated) && (e.Actor.Type != "system" || e.Actor.ID != "" || e.Changes != nil) {
			t.Fatalf("app.created = %+v", e)
		}
	}
	if key == "" {
		t.Fatal("no api_key.created listed")
	}

	// Pagination over equal timestamps: every event once, in the same order.
	var paged []string
	q := url.Values{"limit": {"2"}}
	for range 20 {
		p := f.listAudit(t, "owner", path, q)
		for _, e := range p.Events {
			paged = append(paged, e.ID)
		}
		if p.NextCursor == "" {
			break
		}
		q.Set("cursor", p.NextCursor)
	}
	var ids []string
	for _, e := range all.Events {
		ids = append(ids, e.ID)
	}
	if !slices.Equal(paged, ids) {
		t.Fatalf("paged %v, all %v", paged, ids)
	}

	// Filters.
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	for _, c := range []struct {
		query url.Values
		n     int
	}{
		{url.Values{"action": {"api_key.created"}}, 5},
		{url.Values{"action": {"api_key."}}, 5},
		{url.Values{"action": {"api_key"}}, 0},
		{url.Values{"target_type": {"app"}}, 1},
		{url.Values{"q": {"key-3"}}, 1},
		{url.Values{"actor": {f.users["owner"].String()}, "target_type": {"api_key"}}, 5},
		{url.Values{"actor": {f.users["member"].String()}}, 0},
		{url.Values{"from": {future}}, 0},
		{url.Values{"to": {past}}, 0},
		{url.Values{"from": {past}, "to": {future}, "action": {"app."}}, 1},
	} {
		if l := f.listAudit(t, "owner", path, c.query); len(l.Events) != c.n {
			t.Errorf("%v: %d events, want %d", c.query, len(l.Events), c.n)
		}
	}
	if code, body := f.getAudit("owner", path, url.Values{"cursor": {"bogus"}}); code != http.StatusBadRequest && code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor: %d %s", code, body)
	}

	// view_audit: project and org admins only.
	f.grant(t, "member2", "admin")
	if l := f.listAudit(t, "member2", path, nil); len(l.Events) != want {
		t.Fatalf("project admin sees %d events", len(l.Events))
	}
	f.listAudit(t, "admin", path, nil)
	f.grant(t, "viewer2", "editor")
	for _, u := range []string{"member", "viewer", "viewer2"} {
		for _, p := range []string{path, path + "/actions"} {
			if code, body := f.getAudit(u, p, nil); code != http.StatusForbidden {
				t.Errorf("%s GET %s: %d %s", u, p, code, body)
			}
		}
	}
	if code, _ := f.getAudit("stranger", path, nil); code != http.StatusNotFound {
		t.Errorf("stranger: %d", code)
	}

	// The action catalogue.
	var actions struct {
		Actions []AuditAction `json:"actions"`
	}
	resp := f.api.Get(path+"/actions", as(f.users["owner"]))
	if resp.Code != http.StatusOK {
		t.Fatalf("actions: %d %s", resp.Code, resp.Body)
	}
	actions = decode[struct {
		Actions []AuditAction `json:"actions"`
	}](t, resp)
	if !slices.Contains(actions.Actions, AuditAction{Action: "api_key.created", Label: "API key created"}) {
		t.Fatalf("actions = %+v", actions.Actions)
	}
	for _, a := range actions.Actions {
		if a.Action == string(audit.LoginSucceeded) {
			t.Fatal("account event offered as a filter")
		}
	}
}

func TestOrgAuditEvents(t *testing.T) {
	f := setupAuditEvents(t)
	path := OrgsPath + "/acme/audit-events"

	l := f.listAudit(t, "owner", path, nil)
	if l.RetentionDays != 400 {
		t.Fatalf("retention_days = %d, want 400", l.RetentionDays)
	}
	var orgWide, shop int
	for _, e := range l.Events {
		switch {
		case e.Target != nil && e.Target.Label == "Hidden":
			t.Fatal("event of a project the caller cannot view listed")
		case e.Project == nil:
			orgWide++
		case e.Project.Slug == "shop" && e.Project.Name == "Shop":
			shop++
		default:
			t.Fatalf("event with project %+v", e.Project)
		}
	}
	if shop != f.count(t, `SELECT count(*) FROM audit_events WHERE project_id = $1`, f.project) || orgWide == 0 {
		t.Fatalf("org list: %d org-wide, %d shop events", orgWide, shop)
	}
	if l := f.listAudit(t, "admin", path, url.Values{"action": {"member.added"}}); len(l.Events) != 1 || l.Events[0].Project != nil {
		t.Fatalf("member.added = %+v", l.Events)
	}
	f.listAudit(t, "admin", path+"/actions", nil)

	// Org owners and admins only.
	for _, u := range []string{"member", "viewer"} {
		for _, p := range []string{path, path + "/actions"} {
			if code, body := f.getAudit(u, p, nil); code != http.StatusForbidden {
				t.Errorf("%s GET %s: %d %s", u, p, code, body)
			}
		}
	}
	if code, _ := f.getAudit("stranger", path, nil); code != http.StatusNotFound {
		t.Errorf("stranger: %d", code)
	}
}
