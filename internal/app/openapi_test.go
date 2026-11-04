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

// TestOpenAPISpecSecuritySchemes guards that user sessions are documented
// next to project read keys.
func TestOpenAPISpecSecuritySchemes(t *testing.T) {
	var buf bytes.Buffer
	if err := runOpenAPI(&buf); err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Components struct {
			SecuritySchemes map[string]struct {
				Type         string `json:"type"`
				Scheme       string `json:"scheme"`
				BearerFormat string `json:"bearerFormat"`
			} `json:"securitySchemes"`
		} `json:"components"`
	}
	if err := json.Unmarshal(buf.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	schemes := spec.Components.SecuritySchemes
	if s, ok := schemes["session"]; !ok || s.Type != "http" || s.Scheme != "bearer" || s.BearerFormat != "JWT" {
		t.Errorf("session scheme = %+v (present %t)", s, ok)
	}
	if _, ok := schemes["readKey"]; !ok {
		t.Error("readKey scheme missing")
	}
}

// TestOpenAPIDashboardAcceptsSessionsAndReadKeys guards that every dashboard
// (query) operation documents both a user session and a read key, and the
// project query parameter session callers must send.
func TestOpenAPIDashboardAcceptsSessionsAndReadKeys(t *testing.T) {
	var buf bytes.Buffer
	if err := runOpenAPI(&buf); err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Paths map[string]map[string]struct {
			Tags       []string              `json:"tags"`
			Security   []map[string][]string `json:"security"`
			Parameters []struct {
				Name string `json:"name"`
				In   string `json:"in"`
			} `json:"parameters"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(buf.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	n := 0
	for path, ops := range spec.Paths {
		for method, op := range ops {
			if len(op.Tags) == 0 || op.Tags[0] != "Dashboard" {
				continue
			}
			n++
			has := map[string]bool{}
			for _, req := range op.Security {
				for name := range req {
					has[name] = true
				}
			}
			if !has["session"] || !has["readKey"] {
				t.Errorf("%s %s: security = %v, want session and readKey", method, path, op.Security)
			}
			project := false
			for _, p := range op.Parameters {
				project = project || (p.Name == "project" && p.In == "query")
			}
			if !project {
				t.Errorf("%s %s: no project query parameter", method, path)
			}
		}
	}
	if n == 0 {
		t.Fatal("no Dashboard operations in the spec")
	}
}
