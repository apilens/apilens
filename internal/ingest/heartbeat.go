package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/controlplane/capture"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/server"
)

const (
	// HeartbeatMinInterval is the shortest interval between two accepted
	// heartbeats of one instance; a faster one answers 429.
	HeartbeatMinInterval = 10 * time.Second
	// LastSeenTTL is how long the per app and environment last-seen key
	// lives in Valkey: an app whose key exists is reporting.
	LastSeenTTL = 5 * time.Minute

	maxInstanceIDChars    = 128
	maxSDKNameChars       = 64
	maxRuntimeChars       = 128
	maxHeartbeatStatsSize = 16 << 10
)

// HeartbeatStore persists app instances; *db.Queries satisfies it.
type HeartbeatStore interface {
	UpsertAppInstance(ctx context.Context, arg db.UpsertAppInstanceParams) error
}

// HeartbeatCache rate-limits heartbeats per instance and keeps the cheap
// per app and environment last-seen key.
type HeartbeatCache interface {
	// Allow reports whether a heartbeat for key is due. When it is not, it
	// returns how long until it is.
	Allow(ctx context.Context, key string, every time.Duration) (bool, time.Duration, error)
	// Touch records that app reported in env at t.
	Touch(ctx context.Context, appID uuid.UUID, env string, t time.Time) error
}

// WithHeartbeat enables POST /v1/heartbeat. cache may be nil: heartbeats are
// then neither rate-limited nor mirrored to the last-seen key. Without a
// store the endpoint answers 503.
func (e *Edge) WithHeartbeat(store HeartbeatStore, cache HeartbeatCache) *Edge {
	e.heartbeats = store
	e.heartbeatCache = cache
	return e
}

// Heartbeat is the body of POST /v1/heartbeat, sent by every SDK process on
// start and then about once a minute. Like metadata it must not carry the
// API key: a body with an "api_key" field at any depth is rejected.
type Heartbeat struct {
	_ struct{} `json:"-" additionalProperties:"true"` // newer SDKs may send more

	ProjectSlug string         `json:"project_slug,omitempty" doc:"Optional; must match the API key's project"`
	AppID       string         `json:"app_id,omitempty" doc:"The app: its name (an unknown name creates the app when the key may create apps), slug or UUID. Omitted or empty: the project's default app." example:"storefront"`
	Environment string         `json:"environment,omitempty" doc:"Defaults to production" example:"production"`
	InstanceID  string         `json:"instance_id" minLength:"1" maxLength:"128" doc:"Stable id of the SDK process, generated once per process start" example:"4b0c7a8e-2f0d-4c1e-9a55-0d6f3b1f1a9e"`
	SDKName     string         `json:"sdk_name,omitempty" example:"apilenss"`
	SDKVersion  string         `json:"sdk_version,omitempty" example:"0.5.0"`
	Runtime     string         `json:"runtime,omitempty" doc:"Language runtime and version" example:"python 3.13.1"`
	Release     string         `json:"release,omitempty" doc:"Version of the app being monitored" example:"2026.11.05"`
	Commit      string         `json:"commit,omitempty" doc:"VCS commit of the app being monitored" example:"9f2c1ab"`
	PID         *int64         `json:"pid,omitempty" doc:"OS process id" example:"4242"`
	Stats       map[string]any `json:"stats,omitempty" doc:"SDK counters since start (records queued, sent, dropped). At most 16 KiB."`
}

// HeartbeatPolicy is the remote capture policy of the app, returned on every
// heartbeat. SDKs apply it until the next heartbeat; an app without a saved
// policy gets capture-everything.
type HeartbeatPolicy struct {
	Enabled             bool    `json:"enabled" doc:"False tells the SDK to stop sending records (heartbeats continue)."`
	SampleRate          float64 `json:"sample_rate" minimum:"0" maximum:"1" doc:"Fraction of requests to keep, from 0 to 1."`
	CaptureHeaders      bool    `json:"capture_headers" doc:"Whether request and response headers are captured."`
	CaptureRequestBody  bool    `json:"capture_request_body" doc:"Whether request bodies are captured."`
	CaptureResponseBody bool    `json:"capture_response_body" doc:"Whether response bodies are captured."`
	MaxPayloadBytes     *int    `json:"max_payload_bytes" required:"true" nullable:"true" doc:"Cap on each captured body in bytes; null means no cap beyond the SDK's own."`
}

// HeartbeatAccepted is the response of POST /v1/heartbeat.
type HeartbeatAccepted struct {
	Policy HeartbeatPolicy `json:"policy" doc:"The app's remote capture policy."`
}

func toHeartbeatPolicy(p capture.Policy) HeartbeatPolicy {
	return HeartbeatPolicy{
		Enabled:             p.Enabled,
		SampleRate:          p.SampleRate,
		CaptureHeaders:      p.CaptureHeaders,
		CaptureRequestBody:  p.CaptureRequestBody,
		CaptureResponseBody: p.CaptureResponseBody,
		MaxPayloadBytes:     p.MaxPayloadBytes,
	}
}

func (e *Edge) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	const signal = "heartbeat"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	if e.heartbeats == nil {
		e.fail(w, signal, errUnavailable("Heartbeat store unavailable, retry later"))
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
		e.fail(w, signal, errValidation("heartbeat must not contain an api_key field"))
		return
	}
	var body Heartbeat
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // keep stats numbers exactly as sent
	if err := dec.Decode(&body); err != nil {
		e.fail(w, signal, errValidation("invalid heartbeat: %v", err))
		return
	}
	instance := strings.TrimSpace(body.InstanceID)
	if instance == "" || len(instance) > maxInstanceIDChars {
		e.fail(w, signal, errValidation("instance_id is required, at most %d characters", maxInstanceIDChars))
		return
	}
	if body.PID != nil && *body.PID < 0 {
		e.fail(w, signal, errValidation("pid must not be negative"))
		return
	}
	statsJSON := []byte("{}")
	if body.Stats != nil {
		var err error
		if statsJSON, err = json.Marshal(body.Stats); err != nil {
			e.fail(w, signal, errValidation("invalid stats: %v", err))
			return
		}
		if len(statsJSON) > maxHeartbeatStatsSize {
			e.fail(w, signal, errValidation("stats exceeds %d bytes", maxHeartbeatStatsSize))
			return
		}
	}
	// A heartbeat without app_id is the project's default app.
	batch, aerr := e.resolveBatch(r.Context(), signal, p, []string{body.ProjectSlug}, []string{body.AppID}, false, tally{})
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	appID := batch.id(body.AppID)
	env := environment(body.Environment)

	if aerr = e.allowHeartbeat(r.Context(), appID, env, instance); aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	now := e.now().UTC()
	err := e.heartbeats.UpsertAppInstance(r.Context(), db.UpsertAppInstanceParams{
		AppID:       appID,
		Environment: env,
		InstanceID:  instance,
		ProjectID:   p.ProjectID,
		SdkName:     truncate(strings.TrimSpace(body.SDKName), maxSDKNameChars),
		SdkVersion:  version(body.SDKVersion),
		Runtime:     truncate(strings.TrimSpace(body.Runtime), maxRuntimeChars),
		Release:     truncate(strings.TrimSpace(body.Release), maxReleaseChars),
		Commit:      truncate(strings.TrimSpace(body.Commit), maxCommitChars),
		Pid:         body.PID,
		Stats:       statsJSON,
		SeenAt:      now,
	})
	if err != nil {
		e.logger.Error("store heartbeat", "error", err)
		e.fail(w, signal, errUnavailable("Could not store heartbeat, retry later"))
		return
	}
	if e.heartbeatCache != nil {
		if err := e.heartbeatCache.Touch(r.Context(), appID, env, now); err != nil {
			e.logger.Warn("heartbeat last-seen cache unavailable", "error", err)
		}
	}

	pol := capture.Default()
	if e.capture != nil {
		// The SDK keeps its last policy on 503; answering capture-everything
		// here could undo a disabled app, so a policy that cannot be read is
		// no answer.
		if pol, err = e.capture.Policy(r.Context(), appID); err != nil {
			e.logger.Error("capture policy unavailable for heartbeat", "app_id", appID, "error", err)
			e.fail(w, signal, errUnavailable("Capture policy unavailable, retry later"))
			return
		}
	}
	e.records.WithLabelValues(signal, "accepted").Inc()
	e.batches.WithLabelValues(signal, "200").Inc()
	writeJSON(w, http.StatusOK, HeartbeatAccepted{Policy: toHeartbeatPolicy(pol)})
}

// allowHeartbeat enforces HeartbeatMinInterval per instance. It fails open:
// without an answer from the cache the heartbeat is accepted.
func (e *Edge) allowHeartbeat(ctx context.Context, appID uuid.UUID, env, instance string) *apiError {
	if e.heartbeatCache == nil {
		return nil
	}
	key := appID.String() + ":" + env + ":" + instance
	ok, wait, err := e.heartbeatCache.Allow(ctx, key, HeartbeatMinInterval)
	switch {
	case err != nil:
		e.logger.Warn("heartbeat rate limit unavailable; accepting heartbeat", "error", err)
		return nil
	case ok:
		return nil
	}
	return &apiError{
		status:     http.StatusTooManyRequests,
		Code:       "rate_limited",
		Detail:     fmt.Sprintf("At most one heartbeat per instance every %s", HeartbeatMinInterval),
		retryAfter: max(wait, time.Second),
	}
}

const (
	heartbeatRateKeyPrefix = "apilens:ingest:heartbeat:"
	// LastSeenKeyPrefix prefixes the last-seen key of an app in an
	// environment: LastSeenKeyPrefix + "<app id>:<environment>", holding the
	// unix milliseconds of the last heartbeat.
	LastSeenKeyPrefix = "apilens:app:last_seen:"
)

// setOnce sets KEYS[1] for ARGV[1] milliseconds when it is absent and
// returns 0, otherwise returns its remaining TTL in milliseconds (at least 1).
var setOnce = valkey.NewLuaScript(`
if redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then return 1 end
return ttl
`)

// ValkeyHeartbeats is the HeartbeatCache over Valkey, shared by every edge
// replica.
type ValkeyHeartbeats struct {
	client valkey.Client
}

// NewValkeyHeartbeats returns a HeartbeatCache over client.
func NewValkeyHeartbeats(client valkey.Client) *ValkeyHeartbeats {
	return &ValkeyHeartbeats{client: client}
}

// Allow implements HeartbeatCache.
func (v *ValkeyHeartbeats) Allow(ctx context.Context, key string, every time.Duration) (bool, time.Duration, error) {
	ms, err := setOnce.Exec(ctx, v.client, []string{heartbeatRateKeyPrefix + key}, []string{strconv.FormatInt(every.Milliseconds(), 10)}).AsInt64()
	if err != nil {
		return false, 0, fmt.Errorf("heartbeat rate limit: %w", err)
	}
	return ms == 0, time.Duration(ms) * time.Millisecond, nil
}

// Touch implements HeartbeatCache.
func (v *ValkeyHeartbeats) Touch(ctx context.Context, appID uuid.UUID, env string, t time.Time) error {
	cmd := v.client.B().Set().Key(LastSeenKeyPrefix + appID.String() + ":" + env).
		Value(strconv.FormatInt(t.UnixMilli(), 10)).Ex(LastSeenTTL).Build()
	if err := v.client.Do(ctx, cmd).Error(); err != nil {
		return fmt.Errorf("heartbeat last seen: %w", err)
	}
	return nil
}

// addHeartbeatOperation documents POST /v1/heartbeat in oapi.
func addHeartbeatOperation(oapi *huma.OpenAPI, errBody *huma.Schema) {
	reg := oapi.Components.Schemas
	body := reg.Schema(reflect.TypeFor[Heartbeat](), true, "")
	accepted := reg.Schema(reflect.TypeFor[HeartbeatAccepted](), true, "")
	jsonOf := func(s *huma.Schema) map[string]*huma.MediaType {
		return map[string]*huma.MediaType{"application/json": {Schema: s}}
	}
	errResp := func(desc string) *huma.Response { return &huma.Response{Description: desc, Content: jsonOf(errBody)} }
	oapi.AddOperation(&huma.Operation{
		OperationID: "ingest-heartbeat",
		Method:      http.MethodPost,
		Path:        "/v1/heartbeat",
		Summary:     "Report an SDK instance is alive and fetch the capture policy",
		Description: "Sent by every SDK process on start and then about once a minute. Records the instance as last seen now " +
			"(the app shows as reporting for 5 minutes) and answers the app's remote capture policy, which the SDK applies " +
			"until the next heartbeat. At most one heartbeat per instance every 10 seconds; a faster one answers 429 with " +
			"Retry-After. On 503 the SDK keeps its previous policy. A body with an `api_key` field at any depth is rejected with 422.",
		Tags:        []string{server.TagIngest},
		Security:    []map[string][]string{{SchemeIngestKey: {}}},
		RequestBody: &huma.RequestBody{Required: true, Content: jsonOf(body)},
		Responses: map[string]*huma.Response{
			"200": {Description: "Recorded; the body carries the capture policy", Content: jsonOf(accepted)},
			"401": errResp("Missing or invalid API key"),
			"403": errResp("API key lacks the ingest scope, may not create the app it names, or is limited to other apps"),
			"409": errResp("The app was deleted less than 30 days ago; restore it from Apps"),
			"413": errResp("Body too large"),
			"422": errResp("Invalid payload or an app limit reached"),
			"429": errResp("Heartbeat of this instance less than 10 seconds after the previous one; retry after Retry-After"),
			"503": errResp("Temporarily unavailable; retry after Retry-After"),
		},
	})
}
