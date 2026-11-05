//go:build integration

package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/capture"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/testutil"
)

func capturePolicyPath(app uuid.UUID) string {
	return strings.Replace(CapturePolicyPath, "{id}", app.String(), 1)
}

func TestCapturePolicy(t *testing.T) {
	f := setupProjects(t)
	guard := authz.NewGuard(f.authz, authz.NewPGResolver(f.pool), authz.GuardOptions{}, testutil.Logger(t))
	NewCapturePolicies(capture.NewService(f.pool, audit.New(f.pool)), guard, testutil.Logger(t)).Register(f.api)

	users := map[string]uuid.UUID{}
	for _, role := range []string{"owner", "admin", "member", "viewer", "stranger"} {
		users[role] = f.user(t, "cp-"+role+"@example.com")
	}
	f.mustCreate(t, users["owner"], "Acme", "acme")
	f.join(t, "acme", users["admin"], "admin")
	f.join(t, "acme", users["member"], "member")
	f.join(t, "acme", users["viewer"], "viewer")
	f.mustCreate(t, users["stranger"], "Elsewhere", "elsewhere")
	p := f.mustCreateProject(t, users["owner"], "acme", "Shop", "shop")
	projectID := uuid.MustParse(p.ID)
	var appID uuid.UUID
	if err := f.pool.QueryRow(f.ctx, `SELECT id FROM apps WHERE project_id = $1 AND slug = 'shop'`, projectID).Scan(&appID); err != nil {
		t.Fatal(err)
	}
	path := capturePolicyPath(appID)

	// No row: capture everything, never saved.
	resp := f.api.Get(path, as(users["viewer"]))
	if resp.Code != http.StatusOK {
		t.Fatalf("get: %d %s", resp.Code, resp.Body)
	}
	got := decode[CapturePolicy](t, resp)
	if got.AppID != appID.String() || got.App != "shop" || got.Project != "shop" || !got.Enabled || got.SampleRate != 1 ||
		!got.CaptureHeaders || !got.CaptureRequestBody || !got.CaptureResponseBody ||
		got.MaxPayloadBytes != nil || got.UpdatedAt != nil || got.UpdatedBy != nil {
		t.Fatalf("default = %+v", got)
	}

	// Authorization by role (SpiceDB): viewers and up read, only owners and
	// admins (project#manage_capture) write, strangers never learn the app
	// exists.
	body := map[string]any{
		"enabled": true, "sample_rate": 0.25, "capture_headers": true,
		"capture_request_body": false, "capture_response_body": true, "max_payload_bytes": 4096,
	}
	const (
		ok   = http.StatusOK
		deny = http.StatusForbidden
		hide = http.StatusNotFound
	)
	for _, c := range []struct {
		role     string
		get, put int
	}{
		{"owner", ok, ok}, {"admin", ok, ok}, {"member", ok, deny}, {"viewer", ok, deny}, {"stranger", hide, hide},
	} {
		if resp := f.api.Get(path, as(users[c.role])); resp.Code != c.get {
			t.Errorf("%s get: %d %s, want %d", c.role, resp.Code, resp.Body, c.get)
		}
		if resp := f.api.Put(path, as(users[c.role]), body); resp.Code != c.put {
			t.Errorf("%s put: %d %s, want %d", c.role, resp.Code, resp.Body, c.put)
		}
	}

	// The admin saved last.
	got = decode[CapturePolicy](t, f.api.Get(path, as(users["member"])))
	if !got.Enabled || got.SampleRate != 0.25 || !got.CaptureHeaders || got.CaptureRequestBody || !got.CaptureResponseBody ||
		got.MaxPayloadBytes == nil || *got.MaxPayloadBytes != 4096 || got.UpdatedAt == nil ||
		got.UpdatedBy == nil || *got.UpdatedBy != users["admin"].String() {
		t.Fatalf("saved = %+v", got)
	}
	if n := f.count(t, `SELECT count(*) FROM capture_policies WHERE app_id = $1`, appID); n != 1 {
		t.Fatalf("rows = %d, want 1", n)
	}

	// Every change is audited with the new values.
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'capture_policy.updated' AND metadata->>'app_id' = $1`, appID.String()); n != 2 {
		t.Fatalf("audit events = %d, want 2", n)
	}
	var actor uuid.UUID
	var rate float64
	if err := f.pool.QueryRow(f.ctx, `SELECT actor_user_id, (metadata->>'sample_rate')::float8 FROM audit_events
		WHERE event = 'capture_policy.updated' ORDER BY id DESC LIMIT 1`).Scan(&actor, &rate); err != nil {
		t.Fatal(err)
	}
	if actor != users["admin"] || rate != 0.25 {
		t.Fatalf("audit = %s %v", actor, rate)
	}

	// Disabling capture and dropping the cap.
	resp = f.api.Put(path, as(users["owner"]), map[string]any{
		"enabled": false, "sample_rate": 0, "capture_headers": false,
		"capture_request_body": false, "capture_response_body": false, "max_payload_bytes": nil,
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("disable: %d %s", resp.Code, resp.Body)
	}
	if got := decode[CapturePolicy](t, resp); got.Enabled || got.SampleRate != 0 || got.MaxPayloadBytes != nil {
		t.Fatalf("disabled = %+v", got)
	}

	// The heartbeat resolver serves the stored row.
	pol, err := capture.NewResolver(db.New(f.pool), time.Minute).Policy(f.ctx, appID)
	if err != nil {
		t.Fatal(err)
	}
	if pol.Enabled || pol.SampleRate != 0 || pol.CaptureHeaders || pol.MaxPayloadBytes != nil {
		t.Fatalf("resolver = %+v", pol)
	}

	// Refusals.
	expectProblem(t, "too precise", f.api.Put(path, as(users["owner"]), map[string]any{
		"enabled": true, "sample_rate": 0.12345, "capture_headers": true, "capture_request_body": true, "capture_response_body": true,
	}), http.StatusBadRequest, "invalid_request")
	if resp := f.api.Put(path, as(users["owner"]), map[string]any{
		"enabled": true, "sample_rate": 1.5, "capture_headers": true, "capture_request_body": true, "capture_response_body": true,
	}); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("sample_rate 1.5: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Put(path, as(users["owner"]), map[string]any{"enabled": true}); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("partial body: %d %s", resp.Code, resp.Body)
	}
	expectProblem(t, "unknown app", f.api.Get(capturePolicyPath(uuid.New()), as(users["owner"])), http.StatusNotFound, "not_found")
	if resp := f.api.Get(path); resp.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", resp.Code)
	}

	// A deleted app is gone.
	if _, err := f.pool.Exec(f.ctx, `UPDATE apps SET deleted_at = now() WHERE id = $1`, appID); err != nil {
		t.Fatal(err)
	}
	expectProblem(t, "deleted app", f.api.Get(path, as(users["owner"])), http.StatusNotFound, "not_found")
}
