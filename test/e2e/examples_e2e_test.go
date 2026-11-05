//go:build e2e

package e2e

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestExampleAppsEndToEnd drives the FastAPI, Express and Spring example apps
// (`task examples:up`, deploy/compose/compose.examples.yaml) and checks that
// what each SDK captured reaches ClickHouse. Skipped unless
//
//	APILENS_E2E_EXAMPLES=http://127.0.0.1:18001,http://127.0.0.1:18002,http://127.0.0.1:18003
//
// is set and the apps run with a capturing posture (not `off`).
func TestExampleAppsEndToEnd(t *testing.T) {
	e := loadEnv(t)
	var bases []string
	for _, b := range strings.Split(os.Getenv("APILENS_E2E_EXAMPLES"), ",") {
		if b = strings.TrimRight(strings.TrimSpace(b), "/"); b != "" {
			bases = append(bases, b)
		}
	}
	if len(bases) == 0 {
		t.Skip("APILENS_E2E_EXAMPLES not set; run `task examples:up` and list the example app URLs")
	}

	const boom = "SELECT count() FROM api_requests WHERE path = '/boom' AND status_code = 500"
	const invalid = "SELECT count() FROM api_requests WHERE path = '/orders' AND method = 'POST' AND status_code = 422"
	boomBefore, invalidBefore := e.count(t, boom), e.count(t, invalid)

	client := &http.Client{Timeout: 15 * time.Second}
	do := func(method, url, body string, want int) {
		t.Helper()
		req, _ := http.NewRequestWithContext(context.Background(), method, url, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, url, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("%s %s: status %d, want %d", method, url, resp.StatusCode, want)
		}
	}
	for _, base := range bases {
		do(http.MethodGet, base+"/boom", "", http.StatusInternalServerError)
		do(http.MethodPost, base+"/orders", `{"item":"","quantity":0}`, http.StatusUnprocessableEntity)
	}

	e.eventually(t, "example 500s", boom, boomBefore+len(bases))
	e.eventually(t, "example 422s", invalid, invalidBefore+len(bases))
}
