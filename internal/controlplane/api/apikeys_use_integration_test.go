//go:build integration

package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appsvc "github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/config"
)

// Creating a key records its creator; the list shows them, falls back to
// the email when the user has no name, and shows null once the account is
// deleted.
func TestAPIKeyCreator(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "c-owner@example.com")
	member := f.user(t, "c-member@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	f.mustCreateProject(t, owner, "acme", "Shop", "shop")

	created := f.mustCreateKey(t, member, "shop", "CI", "ingest")
	if created.CreatedBy == nil || created.CreatedBy.ID != member.String() || created.CreatedBy.Name != "Ada" {
		t.Fatalf("created_by on create = %+v", created.CreatedBy)
	}
	list := f.listKeys(t, owner, "shop")
	if len(list) != 1 || list[0].CreatedBy == nil || list[0].CreatedBy.ID != member.String() || list[0].CreatedBy.Name != "Ada" {
		t.Fatalf("list created_by = %+v", list)
	}
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE id = $1 AND created_by = $2`, created.ID, member); n != 1 {
		t.Fatal("created_by not stored")
	}

	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET name = '' WHERE id = $1`, member); err != nil {
		t.Fatal(err)
	}
	if list := f.listKeys(t, owner, "shop"); list[0].CreatedBy == nil || list[0].CreatedBy.Name != "c-member@example.com" {
		t.Fatalf("nameless creator = %+v", list[0].CreatedBy)
	}

	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, member); err != nil {
		t.Fatal(err)
	}
	resp := f.api.Get(ProjectsPath+"/shop/api-keys", as(owner))
	if resp.Code != http.StatusOK || strings.Contains(resp.Body.String(), `"created_by"`) {
		t.Fatalf("deleted creator: %d %s", resp.Code, resp.Body)
	}
	for _, field := range []string{`"last_used_sdk":null`, `"last_used_ip":null`} {
		if !strings.Contains(resp.Body.String(), field) {
			t.Errorf("unused key lacks %s: %s", field, resp.Body)
		}
	}
}

// An ingest batch records the key's SDK and client IP with last_used_at;
// another batch inside the throttle window rewrites none of them.
func TestIngestRecordsKeyLastUse(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "u-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	key := f.mustCreateKey(t, owner, "shop", "Ingest", "ingest")

	apps := catalog.NewAppResolver(db.New(f.pool), time.Minute).WithProvisioner(appsvc.NewProvisioner(f.pool, nil, appsvc.Limits{}))
	edge := ingest.New(f.verifier, apps, &recordingSink{},
		config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000, RecordKeyIP: true},
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	mux := http.NewServeMux()
	edge.Register(mux)
	send := func(ua, peer string) {
		t.Helper()
		ts := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
		body := `{"requests":[{"app_id":"shop","timestamp":"` + ts + `","method":"GET","path":"/orders","status_code":200,"response_time_ms":3}]}`
		req := httptest.NewRequest(http.MethodPost, "/v1/requests", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", key.Key)
		req.Header.Set("User-Agent", ua)
		req.RemoteAddr = peer
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("ingest: %d %s", rec.Code, rec.Body)
		}
	}

	send("apilenss/0.5.0 (CPython 3.13)", "203.0.113.7:51234")
	var item APIKey
	deadline := time.Now().Add(5 * time.Second)
	for {
		item = f.listKeys(t, owner, "shop")[0]
		if item.LastUsedAt != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("last_used_at never recorded")
		}
		time.Sleep(25 * time.Millisecond)
	}
	if item.LastUsedSDK == nil || *item.LastUsedSDK != "apilenss/0.5.0" || item.LastUsedIP == nil || *item.LastUsedIP != "203.0.113.7" {
		t.Fatalf("last use = sdk %v ip %v", item.LastUsedSDK, item.LastUsedIP)
	}
	first := *item.LastUsedAt

	// Within the throttle window (5 minutes by default) nothing is rewritten.
	send("other-sdk/9.9.9", "198.51.100.1:1")
	time.Sleep(300 * time.Millisecond)
	again := f.listKeys(t, owner, "shop")[0]
	if again.LastUsedAt == nil || !again.LastUsedAt.Equal(first) ||
		*again.LastUsedSDK != "apilenss/0.5.0" || *again.LastUsedIP != "203.0.113.7" {
		t.Fatalf("rewritten within the window: at %v sdk %v ip %v", again.LastUsedAt, *again.LastUsedSDK, *again.LastUsedIP)
	}
}
