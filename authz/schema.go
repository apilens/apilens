// Package authz embeds the SpiceDB schema so `apilens migrate` can apply it.
package authz

import (
	_ "embed"
	"strings"
)

// Schema is the contents of schema.zed.
//
//go:embed schema.zed
var Schema string

// bridgeTerms are the project permissions that, before the default-access
// relations (ADR 0009), flowed down from the organization, and the term
// each one had for it.
var bridgeTerms = []struct{ line, term string }{
	{"permission manage_keys = admin + editor + default_editor + org->manage", " + org->create_project"},
	{"permission edit = admin + editor + default_editor + org->manage", " + org->create_project"},
	{"permission view = viewer + default_viewer + edit", " + org->view"},
}

// BridgeSchema is Schema with the organization terms of the previous schema
// kept on the project permissions: an org member still edits and an org
// viewer still views every project through the organization. `apilens
// migrate` writes it when it upgrades a SpiceDB whose schema predates the
// default relations, backfills them with the reconciler, then writes Schema,
// so no org member is locked out in between (authz/README.md). It never
// grants more than the previous schema did. ok is false when Schema no
// longer has the lines it extends.
func BridgeSchema() (schema string, ok bool) {
	schema = Schema
	for _, b := range bridgeTerms {
		if strings.Count(schema, b.line+"\n") != 1 {
			return "", false
		}
		schema = strings.Replace(schema, b.line+"\n", b.line+b.term+"\n", 1)
	}
	return schema, true
}

// InheritsOrgAccess reports whether a SpiceDB schema (as ReadSchema returns
// it) still lets org members and viewers into every project through the
// organization: the schema before the default relations, or BridgeSchema.
// `apilens migrate` then needs to backfill before it writes Schema.
func InheritsOrgAccess(schema string) bool {
	i := strings.Index(schema, "definition project")
	return i >= 0 && strings.Contains(schema[i:], "org->view")
}
