package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/server"
)

const (
	// maxMetadataRoutes caps the route templates stored per app and
	// environment; the SDKs cap at the same number.
	maxMetadataRoutes = 2000
	// maxMetadataConfigBytes caps the stored effective SDK config.
	maxMetadataConfigBytes = 64 << 10
	maxVersionChars        = 64
	maxFrameworkChars      = 64
)

// MetadataStore persists app metadata; *db.Queries satisfies it.
type MetadataStore interface {
	UpsertAppMetadata(ctx context.Context, arg db.UpsertAppMetadataParams) error
}

// WithMetadata enables POST /v1/metadata. Without it the endpoint answers
// 503.
func (e *Edge) WithMetadata(store MetadataStore) *Edge {
	e.metadata = store
	return e
}

// AppMetadataRoute is one route template an app's framework declares.
type AppMetadataRoute struct {
	Method string `json:"method" doc:"HTTP method, e.g. GET" example:"GET"`
	Path   string `json:"path" doc:"Route template as the framework declares it" example:"/orders/{id}"`
}

// AppMetadata is the body of POST /v1/metadata, sent by the SDKs once per
// process start. It must not carry the API key: a body with an "api_key"
// field at any depth is rejected.
type AppMetadata struct {
	_ struct{} `json:"-" additionalProperties:"true"` // newer SDKs may send more

	ProjectSlug     string             `json:"project_slug,omitempty" doc:"Optional; must match the API key's project"`
	AppID            string             `json:"app_id" doc:"App UUID or slug" example:"storefront"`
	Environment      string             `json:"environment,omitempty" doc:"Defaults to production" example:"production"`
	Framework        string             `json:"framework,omitempty" doc:"Web framework; also recorded on the app when it has none yet" example:"fastapi"`
	FrameworkVersion string             `json:"framework_version,omitempty" example:"0.115.0"`
	RuntimeVersion   string             `json:"runtime_version,omitempty" doc:"Language runtime version" example:"3.13.1"`
	PythonVersion    string             `json:"python_version,omitempty" doc:"Alias of runtime_version (Python SDK)"`
	NodeVersion      string             `json:"node_version,omitempty" doc:"Alias of runtime_version (TypeScript SDK)"`
	JavaVersion      string             `json:"java_version,omitempty" doc:"Alias of runtime_version (Java SDK)"`
	SDKVersion       string             `json:"sdk_version,omitempty" example:"0.5.0"`
	Routes           []AppMetadataRoute `json:"routes,omitempty" doc:"Route templates; entries past the first 2000 are dropped"`
	Config           map[string]any     `json:"config,omitempty" doc:"Effective SDK configuration (capture flags, redaction patterns, exclusions, sample rate; callbacks as true). At most 64 KiB."`
}

// AppMetadataAccepted is the response of POST /v1/metadata.
type AppMetadataAccepted struct {
	Accepted        int  `json:"accepted" doc:"Always 1"`
	Routes          int  `json:"routes" doc:"Route templates stored"`
	RoutesTruncated bool `json:"routes_truncated" doc:"True when routes past the cap were dropped"`
}

// IngestError is the error body of the ingest endpoints.
type IngestError struct {
	Error  string `json:"error" doc:"Stable error code" example:"validation_error"`
	Detail any    `json:"detail" doc:"Human-readable detail"`
}

// SchemeIngestKey names the OpenAPI security scheme of ingest operations.
const SchemeIngestKey = "ingestKey"

// RegisterOpenAPI documents the ingest operations served by plain (non-Huma)
// handlers in api's OpenAPI document. It registers no handler.
func RegisterOpenAPI(api huma.API) {
	oapi := api.OpenAPI()
	if oapi.Components.SecuritySchemes == nil {
		oapi.Components.SecuritySchemes = map[string]*huma.SecurityScheme{}
	}
	oapi.Components.SecuritySchemes[SchemeIngestKey] = &huma.SecurityScheme{
		Type: "apiKey", In: "header", Name: "X-API-Key",
		Description: "Project API key with the ingest scope.",
	}
	reg := oapi.Components.Schemas
	body := reg.Schema(reflect.TypeFor[AppMetadata](), true, "")
	accepted := reg.Schema(reflect.TypeFor[AppMetadataAccepted](), true, "")
	errBody := reg.Schema(reflect.TypeFor[IngestError](), true, "")
	jsonOf := func(s *huma.Schema) map[string]*huma.MediaType {
		return map[string]*huma.MediaType{"application/json": {Schema: s}}
	}
	errResp := func(desc string) *huma.Response { return &huma.Response{Description: desc, Content: jsonOf(errBody)} }
	oapi.AddOperation(&huma.Operation{
		OperationID: "ingest-app-metadata",
		Method:      http.MethodPost,
		Path:        "/v1/metadata",
		Summary:     "Report app metadata",
		Description: "Sent by the SDKs once per process start: framework and versions, the route templates the " +
			"framework declares (at most 2000 are kept) and the effective SDK config. Replaces the previous report " +
			"of the app in the environment, and records the framework on the app when it has none. A body with an " +
			"`api_key` field at any depth is rejected with 422.",
		Tags:        []string{server.TagIngest},
		Security:    []map[string][]string{{SchemeIngestKey: {}}},
		RequestBody: &huma.RequestBody{Required: true, Content: jsonOf(body)},
		Responses: map[string]*huma.Response{
			"200": {Description: "Stored", Content: jsonOf(accepted)},
			"401": errResp("Missing or invalid API key"),
			"403": errResp("API key lacks the ingest scope"),
			"413": errResp("Body too large"),
			"422": errResp("Invalid payload, unknown app, or an api_key field"),
			"503": errResp("Temporarily unavailable; retry after Retry-After"),
		},
	})
}

func (e *Edge) handleMetadata(w http.ResponseWriter, r *http.Request) {
	const signal = "metadata"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	if e.metadata == nil {
		e.fail(w, signal, errUnavailable("Metadata store unavailable, retry later"))
		return
	}
	var raw json.RawMessage
	if _, aerr = e.decodeJSON(w, r, &raw); aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	var tree any
	if err := json.Unmarshal(raw, &tree); err != nil {
		e.fail(w, signal, errValidation("invalid JSON: %v", err))
		return
	}
	if hasAPIKeyField(tree) {
		e.fail(w, signal, errValidation("metadata must not contain an api_key field"))
		return
	}
	var body AppMetadata
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // keep config numbers exactly as sent
	if err := dec.Decode(&body); err != nil {
		e.fail(w, signal, errValidation("invalid metadata: %v", err))
		return
	}
	if strings.TrimSpace(body.AppID) == "" {
		e.fail(w, signal, errValidation("app_id is required"))
		return
	}
	apps, aerr := e.resolveApps(r.Context(), p, []string{body.ProjectSlug}, []string{body.AppID}, false)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}

	routes, truncated := metadataRoutes(body.Routes)
	routesJSON, err := json.Marshal(routes)
	if err != nil {
		e.fail(w, signal, errValidation("invalid routes: %v", err))
		return
	}
	configJSON := []byte("{}")
	if body.Config != nil {
		if configJSON, err = json.Marshal(body.Config); err != nil {
			e.fail(w, signal, errValidation("invalid config: %v", err))
			return
		}
		if len(configJSON) > maxMetadataConfigBytes {
			e.fail(w, signal, errValidation("config exceeds %d bytes", maxMetadataConfigBytes))
			return
		}
	}
	runtime := body.RuntimeVersion
	for _, alias := range []string{body.PythonVersion, body.NodeVersion, body.JavaVersion} {
		if strings.TrimSpace(runtime) == "" {
			runtime = alias
		}
	}
	err = e.metadata.UpsertAppMetadata(r.Context(), db.UpsertAppMetadataParams{
		AppID:            apps[strings.TrimSpace(body.AppID)],
		Environment:      environment(body.Environment),
		ProjectID:        p.ProjectID,
		Framework:        truncate(strings.ToLower(strings.TrimSpace(body.Framework)), maxFrameworkChars),
		FrameworkVersion: version(body.FrameworkVersion),
		RuntimeVersion:   version(runtime),
		SdkVersion:       version(body.SDKVersion),
		Routes:           routesJSON,
		Config:           configJSON,
		ReceivedAt:       e.now().UTC(),
	})
	if err != nil {
		e.logger.Error("store app metadata", "error", err)
		e.fail(w, signal, errUnavailable("Could not store metadata, retry later"))
		return
	}
	e.records.WithLabelValues(signal, "accepted").Inc()
	e.batches.WithLabelValues(signal, "200").Inc()
	writeJSON(w, http.StatusOK, AppMetadataAccepted{Accepted: 1, Routes: len(routes), RoutesTruncated: truncated})
}

func version(s string) string { return truncate(strings.TrimSpace(s), maxVersionChars) }

// metadataRoutes normalises route templates: upper-case methods, trimmed
// paths, entries without a method or path and duplicates dropped, at most
// maxMetadataRoutes kept.
func metadataRoutes(in []AppMetadataRoute) ([]AppMetadataRoute, bool) {
	out := make([]AppMetadataRoute, 0, min(len(in), maxMetadataRoutes))
	seen := make(map[AppMetadataRoute]bool, len(out))
	for _, rt := range in {
		rt = AppMetadataRoute{Method: truncate(strings.ToUpper(strings.TrimSpace(rt.Method)), 16), Path: short(rt.Path)}
		if rt.Method == "" || rt.Path == "" || seen[rt] {
			continue
		}
		if len(out) == maxMetadataRoutes {
			return out, true
		}
		seen[rt] = true
		out = append(out, rt)
	}
	return out, false
}

// hasAPIKeyField reports whether a decoded JSON value has an object key
// naming an API key ("api_key", "apiKey", "api-key", any case) at any depth.
func hasAPIKeyField(v any) bool {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			if isAPIKeyName(k) || hasAPIKeyField(child) {
				return true
			}
		}
	case []any:
		for _, child := range t {
			if hasAPIKeyField(child) {
				return true
			}
		}
	}
	return false
}

var apiKeyNameReplacer = strings.NewReplacer("_", "", "-", "", ".", "", " ", "")

func isAPIKeyName(k string) bool {
	k = strings.ToLower(k)
	return apiKeyNameReplacer.Replace(k) == "apikey"
}
