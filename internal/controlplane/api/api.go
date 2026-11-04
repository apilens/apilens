// Package api is the control-plane API role: organizations, projects, apps,
// members and keys. It mounts its operations on the typed API.
package api

import "github.com/danielgtaylor/huma/v2"

// Register mounts the control-plane operations on api. There are none yet;
// later M2 tasks add them.
func Register(api huma.API) {
	_ = api
}
