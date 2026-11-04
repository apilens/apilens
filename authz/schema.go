// Package authz embeds the SpiceDB schema so `apilens migrate` can apply it.
package authz

import _ "embed"

// Schema is the contents of schema.zed.
//
//go:embed schema.zed
var Schema string
