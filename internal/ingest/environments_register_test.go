package ingest

import (
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// fakeEnvRegistry records what the edge reports.
type fakeEnvRegistry struct {
	mu    sync.Mutex
	calls [][]string
}

func (f *fakeEnvRegistry) Seen(projectID, keyID uuid.UUID, names []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if projectID != testProject || keyID != testKeyID {
		panic("wrong project or key")
	}
	f.calls = append(f.calls, append([]string(nil), names...))
}

func TestStoredEnvironmentsAreReported(t *testing.T) {
	envs := &fakeEnvRegistry{}
	e, h := newPinnedEdge(t, []string{"staging", "qa"}, &fakeSink{}, &fakeMetadata{}, &fakeHeartbeats{})
	e.WithEnvironments(envs)

	// The distinct environments of stored records only: production is
	// rejected by the key's environments, so it is not registered.
	body := `{"logs":[
	 {"app_id":"storefront","environment":"staging","timestamp":"2026-10-22T11:59:00Z","level":"info","message":"a"},
	 {"app_id":"storefront","environment":"production","timestamp":"2026-10-22T11:59:00Z","level":"info","message":"b"},
	 {"app_id":"storefront","environment":" qa ","timestamp":"2026-10-22T11:59:00Z","level":"info","message":"c"},
	 {"app_id":"storefront","environment":"staging","timestamp":"2026-10-22T11:59:00Z","level":"info","message":"d"}]}`
	if rec := post(t, h, "/v1/logs", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if len(envs.calls) != 1 || strings.Join(envs.calls[0], ",") != "staging,qa" {
		t.Fatalf("reported %v", envs.calls)
	}

	// Heartbeats name an environment too; a call whose every record is
	// rejected reports nothing.
	if rec := post(t, h, "/v1/heartbeat", validHeartbeat, nil); rec.Code != http.StatusOK {
		t.Fatalf("heartbeat %d %s", rec.Code, rec.Body)
	}
	if rec := post(t, h, "/v1/requests", validRequest, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("production request %d %s", rec.Code, rec.Body)
	}
	if len(envs.calls) != 2 || strings.Join(envs.calls[1], ",") != "staging" {
		t.Fatalf("reported %v", envs.calls)
	}
}
