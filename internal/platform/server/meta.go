package server

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/platform/buildinfo"
)

// MetaOutput is the response of GET /api/v1/meta.
type MetaOutput struct {
	Body struct {
		Name      string   `json:"name" example:"apilens"`
		Version   string   `json:"version" example:"v2.0.0"`
		Commit    string   `json:"commit,omitempty"`
		GoVersion string   `json:"go_version"`
		Roles     []string `json:"roles" doc:"Roles running in this process."`
	}
}

// RegisterMeta adds the build/runtime metadata endpoint. It is the first
// typed operation and anchors the committed OpenAPI spec.
func RegisterMeta(api huma.API, roles []string) {
	huma.Register(api, huma.Operation{
		OperationID: "get-meta",
		Method:      http.MethodGet,
		Path:        APIPrefix + "/meta",
		Summary:     "Build and runtime metadata",
		Tags:        []string{"System"},
	}, func(_ context.Context, _ *struct{}) (*MetaOutput, error) {
		info := buildinfo.Get()
		out := &MetaOutput{}
		out.Body.Name = "apilens"
		out.Body.Version = info.Version
		out.Body.Commit = info.Commit
		out.Body.GoVersion = info.GoVersion
		out.Body.Roles = roles
		return out, nil
	})
}
