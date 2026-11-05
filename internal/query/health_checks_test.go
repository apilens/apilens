package query

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/alerts"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

func TestCheckHealthCheckBody(t *testing.T) {
	off := false
	ok := healthCheckBody{Environment: " production ", URL: " https://api.example.com/healthz "}
	s := NewService(nil, nil)
	v, err := s.checkHealthCheckBody(ok)
	if err != nil || v.environment != "production" || v.url != "https://api.example.com/healthz" || v.expected != 200 || !v.enabled {
		t.Fatalf("defaults = %+v, %v", v, err)
	}
	if v, err := s.checkHealthCheckBody(healthCheckBody{Environment: "staging", URL: "http://api.example.com/", ExpectedStatus: 204, Enabled: &off}); err != nil || v.expected != 204 || v.enabled {
		t.Errorf("explicit = %+v, %v", v, err)
	}
	for name, b := range map[string]healthCheckBody{
		"blank environment":       {Environment: "  ", URL: "https://api.example.com/"},
		"expected status too low": {Environment: "production", URL: "https://api.example.com/", ExpectedStatus: 99},
		"not http":                {Environment: "production", URL: "ftp://api.example.com/"},
		"credentials":             {Environment: "production", URL: "https://a:b@api.example.com/"},
		"loopback":                {Environment: "production", URL: "http://127.0.0.1:8080/healthz"},
		"metadata service":        {Environment: "production", URL: "http://169.254.169.254/latest/meta-data/"},
		"private":                 {Environment: "production", URL: "http://10.1.2.3/"},
		"localhost":               {Environment: "production", URL: "http://localhost/"},
	} {
		_, err := s.checkHealthCheckBody(b)
		var se huma.StatusError
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if !errors.As(err, &se) || se.GetStatus() != 422 {
			t.Errorf("%s: %v, want 422", name, err)
		}
	}
	// A self-hosted install that allows private networks.
	private := NewService(nil, nil).WithHealthCheckPrivateNetworks(true)
	if v, err := private.checkHealthCheckBody(healthCheckBody{Environment: "production", URL: "http://10.1.2.3:8080/healthz"}); err != nil || v.url != "http://10.1.2.3:8080/healthz" {
		t.Errorf("private allowed = %+v, %v", v, err)
	}
	if _, err := private.checkHealthCheckBody(healthCheckBody{Environment: "production", URL: "file:///etc/passwd"}); err == nil {
		t.Error("file URL accepted with private networks allowed")
	}
}

func TestToHealthCheck(t *testing.T) {
	at := time.Date(2026, 11, 4, 9, 30, 0, 0, time.UTC)
	details, _ := json.Marshal(alerts.HealthCheckResult{
		StatusCode: 503, ExpectedStatus: 200, LatencyMS: 41.2, Error: "unexpected status 503",
		BodySnippet: `{"password":"[redacted]"}`, Attempts: 2, CheckedAt: at,
	})
	h := toHealthCheck(db.HealthCheck{
		ID: uuid.New(), AppID: uuid.New(), Environment: "production", Url: "https://api.example.com/healthz",
		ExpectedStatus: 200, Enabled: true, Status: "down", StatusSince: at, CheckedAt: &at, LastResult: details,
		CreatedAt: at, UpdatedAt: at,
	})
	if h.LastResult == nil || h.LastResult.StatusCode != 503 || h.LastResult.Attempts != 2 ||
		h.LastResult.BodySnippet != `{"password":"[redacted]"}` || h.Status != "down" || h.CreatedBy != nil {
		t.Errorf("check = %+v", h)
	}
	b, _ := json.Marshal(h)
	if !strings.Contains(string(b), `"last_result":{"ok":false,"status_code":503`) {
		t.Errorf("json = %s", b)
	}
	if never := toHealthCheck(db.HealthCheck{ID: uuid.New(), AppID: uuid.New()}); never.LastResult != nil || never.CheckedAt != nil {
		t.Errorf("never checked = %+v", never)
	}
}
