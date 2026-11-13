package authz

import (
	"strings"
	"testing"
)

func TestBridgeSchemaKeepsOrgTerms(t *testing.T) {
	bridge, ok := BridgeSchema()
	if !ok {
		t.Fatal("BridgeSchema does not match schema.zed; update bridgeTerms with the project permissions")
	}
	for _, b := range bridgeTerms {
		if !strings.Contains(bridge, b.line+b.term+"\n") {
			t.Errorf("bridge lacks %q", b.line+b.term)
		}
	}
	if len(bridge) != len(Schema)+len(" + org->create_project")*2+len(" + org->view") {
		t.Error("bridge differs from schema.zed in more than the three org terms")
	}
}

func TestInheritsOrgAccess(t *testing.T) {
	bridge, _ := BridgeSchema()
	for _, c := range []struct {
		name, schema string
		want         bool
	}{
		{"current", Schema, false},
		{"bridge", bridge, true},
		{"previous", "definition organization {\n\tpermission view = viewer\n}\ndefinition project {\n\tpermission view = viewer + edit + org->view\n}", true},
		{"none", "", false},
	} {
		if got := InheritsOrgAccess(c.schema); got != c.want {
			t.Errorf("%s: InheritsOrgAccess = %v, want %v", c.name, got, c.want)
		}
	}
}
