package query

import (
	"encoding/json"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2/humatest"
)

// documentedOperations are the query API operations whose contract in
// api/openapi/apilens.v1.json must be fully described: the dashboard reads
// and the per-endpoint, per-app and saved-view settings the UI codegen and
// docs rely on.
var documentedOperations = []string{
	"get-project", "get-traffic-summary", "get-traffic-timeseries", "get-traffic-latency", "list-endpoints",
	"get-endpoint-requests", "get-endpoint-latency", "get-endpoint-transfer", "get-endpoint-errors",
	"get-endpoint-settings", "put-endpoint-settings", "get-app-settings", "put-app-settings",
	"list-requests", "get-request-timeline", "get-request", "get-trace",
	"create-request-export", "get-request-export", "cancel-request-export", "download-request-export",
	"list-saved-views", "get-saved-view", "create-saved-view", "update-saved-view", "delete-saved-view",
	"list-consumers", "get-consumer", "list-consumer-groups", "create-consumer-group", "rename-consumer-group",
	"delete-consumer-group", "assign-consumer-group", "unassign-consumer-group",
	"list-errors", "get-error-statuses", "get-error-status",
	"get-app-status", "get-app-ingest-stats", "get-ingest-status", "list-deploys", "list-deploy-changes",
}

// TestOpenAPIDocumentsQueryOperations checks every documented operation has
// a summary and a description, every parameter a description, and every
// property of the schemas it reaches (request and response bodies) a
// description.
func TestOpenAPIDocumentsQueryOperations(t *testing.T) {
	_, api := humatest.New(t)
	Register(api, nil, nil)
	raw, err := json.Marshal(api.OpenAPI())
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}

	found := map[string]bool{}
	schemas := map[string]bool{}
	for path, item := range spec.Paths {
		for method, rawOp := range item {
			var op struct {
				OperationID string `json:"operationId"`
				Summary     string `json:"summary"`
				Description string `json:"description"`
				Parameters  []struct {
					Name        string `json:"name"`
					Description string `json:"description"`
				} `json:"parameters"`
			}
			if err := json.Unmarshal(rawOp, &op); err != nil || !slices.Contains(documentedOperations, op.OperationID) {
				continue
			}
			found[op.OperationID] = true
			where := strings.ToUpper(method) + " " + path
			if op.Summary == "" || op.Description == "" {
				t.Errorf("%s (%s): summary and description are required", where, op.OperationID)
			}
			for _, p := range op.Parameters {
				if p.Description == "" {
					t.Errorf("%s: parameter %q has no description", where, p.Name)
				}
			}
			for _, ref := range schemaRefs(string(rawOp)) {
				schemas[ref] = true
			}
		}
	}
	for _, id := range documentedOperations {
		if !found[id] {
			t.Errorf("operation %s is not registered", id)
		}
	}

	// Walk the schemas the operations reach, transitively.
	queue := make([]string, 0, len(schemas))
	for name := range schemas {
		queue = append(queue, name)
	}
	var missing []string
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		s, ok := spec.Components.Schemas[name]
		if !ok {
			t.Errorf("schema %s is referenced but not defined", name)
			continue
		}
		props, _ := s["properties"].(map[string]any)
		for prop, v := range props {
			p, _ := v.(map[string]any)
			if prop != "$schema" && p["description"] == nil {
				missing = append(missing, name+"."+prop)
			}
		}
		b, _ := json.Marshal(s)
		for _, ref := range schemaRefs(string(b)) {
			if !schemas[ref] {
				schemas[ref] = true
				queue = append(queue, ref)
			}
		}
	}
	sort.Strings(missing)
	for _, m := range missing {
		t.Errorf("property %s has no description (add a doc tag)", m)
	}
}

// schemaRefs returns the component schema names referenced in raw JSON.
func schemaRefs(raw string) []string {
	const prefix = `"$ref":"#/components/schemas/`
	var refs []string
	for {
		i := strings.Index(raw, prefix)
		if i < 0 {
			return refs
		}
		raw = raw[i+len(prefix):]
		end := strings.IndexByte(raw, '"')
		if end < 0 {
			return refs
		}
		refs = append(refs, raw[:end])
		raw = raw[end:]
	}
}
