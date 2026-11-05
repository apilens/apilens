package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/config"
)

type fakeMetadata struct {
	mu   sync.Mutex
	err  error
	rows []db.UpsertAppMetadataParams
}

func (f *fakeMetadata) UpsertAppMetadata(_ context.Context, arg db.UpsertAppMetadataParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.rows = append(f.rows, arg)
	return nil
}

func newMetadataEdge(t *testing.T, store MetadataStore) http.Handler {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, fakeApps{}, &fakeSink{}, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	e.now = func() time.Time { return fixedNow }
	if store != nil {
		e.WithMetadata(store)
	}
	mux := http.NewServeMux()
	e.Register(mux)
	return mux
}

const validMetadata = `{"project_slug":"shop","app_id":"storefront","environment":"staging",
 "framework":" FastAPI ","framework_version":"0.115.0","python_version":"3.13.1","sdk_version":"0.5.0",
 "routes":[{"method":"get","path":"/orders/{id}"},{"method":"GET","path":"/orders/{id}"},{"method":"post","path":" /orders "},{"method":"","path":"/x"}],
 "config":{"capture_headers":true,"sample_rate":0.25,"big":12345678901234567890,"redact_headers":["^x-api-key$"],"callbacks":{"mask_request_body":true}},
 "future_field":1}`

func TestMetadataHappyPath(t *testing.T) {
	store := &fakeMetadata{}
	rec := post(t, newMetadataEdge(t, store), "/v1/metadata", validMetadata, nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"accepted":1,"routes":2,"routes_truncated":false}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if len(store.rows) != 1 {
		t.Fatalf("rows = %d", len(store.rows))
	}
	row := store.rows[0]
	if row.AppID != testApp || row.ProjectID != testProject || row.Environment != "staging" {
		t.Errorf("ids wrong: %+v", row)
	}
	if row.Framework != "fastapi" || row.FrameworkVersion != "0.115.0" || row.RuntimeVersion != "3.13.1" || row.SdkVersion != "0.5.0" {
		t.Errorf("versions wrong: %+v", row)
	}
	if !row.ReceivedAt.Equal(fixedNow) {
		t.Errorf("received_at = %v", row.ReceivedAt)
	}
	var routes []AppMetadataRoute
	if err := json.Unmarshal(row.Routes, &routes); err != nil {
		t.Fatal(err)
	}
	if want := []AppMetadataRoute{{"GET", "/orders/{id}"}, {"POST", "/orders"}}; !reflect.DeepEqual(routes, want) {
		t.Errorf("routes = %+v, want %+v", routes, want)
	}
	// Config is stored as sent, numbers exactly.
	if want := `{"big":12345678901234567890,"callbacks":{"mask_request_body":true},"capture_headers":true,"redact_headers":["^x-api-key$"],"sample_rate":0.25}`; string(row.Config) != want {
		t.Errorf("config = %s, want %s", row.Config, want)
	}
}

func TestMetadataDefaults(t *testing.T) {
	store := &fakeMetadata{}
	rec := post(t, newMetadataEdge(t, store), "/v1/metadata", `{"app_id":"storefront","node_version":"v22.1.0","runtime_version":" "}`, nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"accepted":1,"routes":0,"routes_truncated":false}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	row := store.rows[0]
	if row.Environment != "production" || row.Framework != "" || row.RuntimeVersion != "v22.1.0" ||
		string(row.Routes) != "[]" || string(row.Config) != "{}" {
		t.Errorf("defaults wrong: %+v routes=%s config=%s", row, row.Routes, row.Config)
	}
}

func TestMetadataRoutesCapped(t *testing.T) {
	routes := make([]string, 0, maxMetadataRoutes+5)
	for i := range maxMetadataRoutes + 5 {
		routes = append(routes, fmt.Sprintf(`{"method":"GET","path":"/r/%d"}`, i))
	}
	store := &fakeMetadata{}
	body := `{"app_id":"storefront","routes":[` + strings.Join(routes, ",") + `]}`
	rec := post(t, newMetadataEdge(t, store), "/v1/metadata", body, nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"accepted":1,"routes":2000,"routes_truncated":true}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	var stored []AppMetadataRoute
	if err := json.Unmarshal(store.rows[0].Routes, &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) != maxMetadataRoutes || stored[len(stored)-1].Path != "/r/1999" {
		t.Errorf("stored %d routes, last %+v", len(stored), stored[len(stored)-1])
	}
}

func TestMetadataRejectsAPIKey(t *testing.T) {
	for name, body := range map[string]string{
		"top level":   `{"app_id":"storefront","api_key":"apl_live_x"}`,
		"in config":   `{"app_id":"storefront","config":{"apiKey":"apl_live_x"}}`,
		"deep, kebab": `{"app_id":"storefront","config":{"exporters":[{"API-Key":"x"}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			store := &fakeMetadata{}
			rec := post(t, newMetadataEdge(t, store), "/v1/metadata", body, nil)
			if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "api_key") {
				t.Fatalf("got %d %s", rec.Code, rec.Body)
			}
			if len(store.rows) != 0 {
				t.Error("payload with an api_key was stored")
			}
		})
	}
	// A pattern naming the header as a value is fine.
	store := &fakeMetadata{}
	if rec := post(t, newMetadataEdge(t, store), "/v1/metadata", `{"app_id":"storefront","config":{"redact_headers":["api_key"]}}`, nil); rec.Code != http.StatusOK {
		t.Fatalf("value api_key rejected: %d %s", rec.Code, rec.Body)
	}
}

func TestMetadataErrors(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		headers map[string]string
		store   MetadataStore
		code    int
	}{
		{"no key", `{"app_id":"storefront"}`, map[string]string{"X-API-Key": ""}, &fakeMetadata{}, http.StatusUnauthorized},
		{"no app", `{"environment":"x"}`, nil, &fakeMetadata{}, http.StatusUnprocessableEntity},
		{"unknown app", `{"app_id":"nope"}`, nil, &fakeMetadata{}, http.StatusUnprocessableEntity},
		{"other project", `{"app_id":"storefront","project_slug":"other"}`, nil, &fakeMetadata{}, http.StatusUnprocessableEntity},
		{"not an object", `[1]`, nil, &fakeMetadata{}, http.StatusUnprocessableEntity},
		{"bad routes", `{"app_id":"storefront","routes":{"a":1}}`, nil, &fakeMetadata{}, http.StatusUnprocessableEntity},
		{"config too big", `{"app_id":"storefront","config":{"x":"` + strings.Repeat("a", maxMetadataConfigBytes) + `"}}`, nil, &fakeMetadata{}, http.StatusUnprocessableEntity},
		{"store down", `{"app_id":"storefront"}`, nil, &fakeMetadata{err: errors.New("db down")}, http.StatusServiceUnavailable},
		{"no store", `{"app_id":"storefront"}`, nil, nil, http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, newMetadataEdge(t, tc.store), "/v1/metadata", tc.body, tc.headers)
			if rec.Code != tc.code {
				t.Fatalf("got %d %s, want %d", rec.Code, rec.Body, tc.code)
			}
			if tc.code == http.StatusServiceUnavailable && rec.Header().Get("Retry-After") == "" {
				t.Error("503 without Retry-After")
			}
		})
	}
}
