package app

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/apilens/apilens/internal/platform/server"
)

// TestOpenAPISpecIsTaggedAndDescribed guards the committed spec: the four
// identity/org tags are declared with descriptions, and every operation has
// a summary and only declared tags.
func TestOpenAPISpecIsTaggedAndDescribed(t *testing.T) {
	var buf bytes.Buffer
	if err := runOpenAPI(&buf); err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Tags []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"tags"`
		Paths map[string]map[string]struct {
			OperationID string   `json:"operationId"`
			Summary     string   `json:"summary"`
			Tags        []string `json:"tags"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(buf.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	declared := map[string]bool{}
	for _, tag := range spec.Tags {
		if tag.Description == "" {
			t.Errorf("tag %q has no description", tag.Name)
		}
		declared[tag.Name] = true
	}
	for _, name := range []string{server.TagAuth, server.TagUsers, server.TagOrganizations, server.TagProjects} {
		if !declared[name] {
			t.Errorf("tag %q not declared", name)
		}
	}
	for path, ops := range spec.Paths {
		for method, op := range ops {
			if op.Summary == "" || len(op.Tags) == 0 {
				t.Errorf("%s %s (%s): missing summary or tags", method, path, op.OperationID)
			}
			for _, tag := range op.Tags {
				if !declared[tag] {
					t.Errorf("%s %s: undeclared tag %q", method, path, tag)
				}
			}
		}
	}
}
