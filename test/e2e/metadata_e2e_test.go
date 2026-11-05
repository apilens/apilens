//go:build e2e

package e2e

import (
	"net/http"
	"strings"
	"testing"
)

// TestMetadataEndToEnd sends the startup metadata an SDK reports and checks
// the edge stores it and refuses a report that carries an API key.
func TestMetadataEndToEnd(t *testing.T) {
	e := loadEnv(t)
	code, body := e.post(t, "/v1/metadata", e.key, map[string]any{
		"app_id": e.app, "environment": "e2e", "framework": "e2e", "framework_version": "1.0.0", "sdk_version": "0.0.0",
		"routes": []map[string]any{{"method": "get", "path": "/orders/{id}"}, {"method": "GET", "path": "/orders/{id}"}, {"method": "post", "path": "/orders"}},
		"config": map[string]any{"capture_headers": true, "sample_rate": 0.5},
	})
	if code != http.StatusOK || !strings.Contains(body, `"accepted":1`) || !strings.Contains(body, `"routes":2`) {
		t.Fatalf("/v1/metadata = %d %s, want accepted with 2 distinct routes", code, body)
	}

	code, body = e.post(t, "/v1/metadata", e.key, map[string]any{
		"app_id": e.app, "environment": "e2e", "config": map[string]any{"api_key": "apl_live_should-never-be-stored"},
	})
	if code != http.StatusUnprocessableEntity || !strings.Contains(body, "api_key") {
		t.Fatalf("/v1/metadata with an api_key = %d %s, want 422", code, body)
	}

	if code, _ := e.post(t, "/v1/metadata", "apl_live_not-a-real-key-not-a-real-key-00000", map[string]any{"app_id": e.app}); code != http.StatusUnauthorized {
		t.Fatalf("/v1/metadata with a bad key = %d, want 401", code)
	}
}
