//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"
)

// TestHeartbeatEndToEnd sends an SDK heartbeat and reads the app's status
// back over the dashboard API: the app is reporting, the instance is listed
// and the heartbeat answer carries the capture policy.
func TestHeartbeatEndToEnd(t *testing.T) {
	e := loadEnv(t)
	readKey := os.Getenv("APILENS_E2E_READ_KEY")
	if readKey == "" {
		t.Skip("APILENS_E2E_READ_KEY not set")
	}
	instance := fmt.Sprintf("e2e-%d", time.Now().UnixNano())

	code, body := e.post(t, "/v1/heartbeat", e.key, map[string]any{
		"app_id": e.app, "environment": "e2e", "instance_id": instance,
		"sdk_name": "e2e", "sdk_version": "0.0.0", "runtime": "go", "pid": 1, "stats": map[string]any{"sent": 1},
	})
	if code != http.StatusOK {
		t.Fatalf("/v1/heartbeat = %d %s", code, body)
	}
	var hb struct {
		Policy *struct {
			Enabled    bool    `json:"enabled"`
			SampleRate float64 `json:"sample_rate"`
		} `json:"policy"`
	}
	if err := json.Unmarshal([]byte(body), &hb); err != nil || hb.Policy == nil {
		t.Fatalf("/v1/heartbeat body %s: %v", body, err)
	}

	var project struct {
		Apps []struct {
			ID   string `json:"id"`
			Slug string `json:"slug"`
		} `json:"apps"`
	}
	e.getJSON(t, readKey, "/api/v1/project", &project)
	appID := ""
	for _, a := range project.Apps {
		if a.Slug == e.app || a.ID == e.app {
			appID = a.ID
		}
	}
	if appID == "" {
		t.Fatalf("app %q not in /api/v1/project: %+v", e.app, project)
	}

	var status struct {
		Status       string `json:"status"`
		Environments []struct {
			Environment string `json:"environment"`
			Status      string `json:"status"`
		} `json:"environments"`
		Instances []struct {
			InstanceID string `json:"instance_id"`
			Status     string `json:"status"`
		} `json:"instances"`
	}
	e.getJSON(t, readKey, "/api/v1/apps/"+appID+"/status", &status)
	if status.Status != "reporting" {
		t.Fatalf("app status = %+v, want reporting", status)
	}
	envOK, instOK := false, false
	for _, env := range status.Environments {
		envOK = envOK || (env.Environment == "e2e" && env.Status == "reporting")
	}
	for _, in := range status.Instances {
		instOK = instOK || (in.InstanceID == instance && in.Status == "reporting")
	}
	if !envOK || !instOK {
		t.Fatalf("app status missing the e2e environment or instance %s: %+v", instance, status)
	}
}
