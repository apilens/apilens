package ingest

import (
	"bytes"
	"cmp"
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
	"github.com/apilens/apilens/internal/pipeline"
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

	ProjectSlug string                      `json:"project_slug,omitempty" doc:"Optional; must match the API key's project"`
	AppID       string                      `json:"app_id,omitempty" doc:"The app: its name (an unknown name creates the app when the key may create apps), slug or UUID. Omitted or empty: the project's default app." example:"storefront"`
	Environment string                      `json:"environment,omitempty" doc:"Defaults to production" example:"production"`
	InstanceID  string                      `json:"instance_id" minLength:"1" maxLength:"128" doc:"Stable id of the SDK process, generated once per process start" example:"4b0c7a8e-2f0d-4c1e-9a55-0d6f3b1f1a9e"`
	SDKName     string                      `json:"sdk_name,omitempty" example:"apilenss"`
	SDKVersion  string                      `json:"sdk_version,omitempty" example:"0.5.0"`
	Runtime     string                      `json:"runtime,omitempty" doc:"Language runtime and version" example:"python 3.13.1"`
	Release     string                      `json:"release,omitempty" doc:"Version of the app being monitored" example:"2026.11.05"`
	Commit      string                      `json:"commit,omitempty" doc:"VCS commit of the app being monitored" example:"9f2c1ab"`
	PID         *int64                      `json:"pid,omitempty" doc:"OS process id" example:"4242"`
	Stats       map[string]any              `json:"stats,omitempty" doc:"SDK counters since start (records queued, sent, dropped). At most 16 KiB."`
	UptimeS     *float64                    `json:"uptime_s,omitempty" nullable:"true" minimum:"0" doc:"Seconds since the SDK process started"`
	Final       bool                        `json:"final,omitempty" doc:"True on the last heartbeat of a process that is shutting down cleanly"`
	Identity    *Identity                   `json:"identity,omitempty" doc:"Where the process runs (host, container, Kubernetes pod). Sent by SDKs with runtime resources."`
	Resources   *Resources                  `json:"resources,omitempty" doc:"CPU, memory and runtime health of the process and its container over the heartbeat window (contract v1). At most 32 KiB. A missing value means it could not be measured, never zero."`
	Dropped     map[string]map[string]int64 `json:"dropped,omitempty" doc:"Records dropped since the previous heartbeat answered 200, per signal (requests, spans, logs) and reason (queue_full, retries_exhausted, ...). The SDK resets them on 200 and adds them to the next heartbeat otherwise. Shown per app and hour in Ingest health; other signals are ignored. At most 32 reasons per signal; reasons are lowercase letters, digits, '_', '.' or '-', up to 64 characters; counts are not negative." example:"{\"requests\":{\"queue_full\":3},\"spans\":{\"retries_exhausted\":12}}"`
}

// HeartbeatPolicy is the remote capture policy of the app, returned on every
// heartbeat. SDKs apply it until the next heartbeat; an app without a saved
// policy gets capture-everything.
type HeartbeatPolicy struct {
	Enabled             bool                     `json:"enabled" doc:"False tells the SDK to stop sending records (heartbeats continue)."`
	SampleRate          float64                  `json:"sample_rate" minimum:"0" maximum:"1" doc:"Fraction of requests to keep, from 0 to 1."`
	CaptureHeaders      bool                     `json:"capture_headers" doc:"Whether request and response headers are captured."`
	CaptureRequestBody  bool                     `json:"capture_request_body" doc:"Whether request bodies are captured."`
	CaptureResponseBody bool                     `json:"capture_response_body" doc:"Whether response bodies are captured."`
	MaxPayloadBytes     *int                     `json:"max_payload_bytes" required:"true" nullable:"true" doc:"Cap on each captured body in bytes; null means no cap beyond the SDK's own."`
	Resources           HeartbeatResourcesPolicy `json:"resources" doc:"Runtime resources sampling. It only narrows the SDK's local config: an SDK never turns on what its own config turned off."`
}

// HeartbeatResourcesPolicy is the resources part of the heartbeat policy.
type HeartbeatResourcesPolicy struct {
	Enabled            bool     `json:"enabled" doc:"False tells the SDK to stop sampling resources."`
	MinIntervalS       int      `json:"min_interval_s" doc:"Shortest sampling interval the SDK may use, in seconds; an SDK configured with a longer one keeps it."`
	DisabledCollectors []string `json:"disabled_collectors" doc:"Collectors the SDK must skip: process.cpu, process.memory, process.pss, container.cpu, container.memory, runtime, pools, processes."`
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
		Resources: HeartbeatResourcesPolicy{
			Enabled:            p.Resources.Enabled,
			MinIntervalS:       p.Resources.MinIntervalS,
			DisabledCollectors: p.Resources.Disabled.Names(),
		},
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
	if body.UptimeS != nil && (!finite(*body.UptimeS) || *body.UptimeS < 0) {
		body.UptimeS = nil
	}
	var part struct {
		Resources json.RawMessage `json:"resources"`
	}
	_ = json.Unmarshal(raw, &part) // raw already decoded once above
	sample, hasResources, aerr := flattenResources(body.Resources, part.Resources)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	drops, aerr := sdkDrops(body.Dropped)
	if aerr != nil {
		e.fail(w, signal, aerr)
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
	batch, aerr := e.resolveBatch(r.Context(), signal, p, []string{body.ProjectSlug}, []string{body.AppID}, []string{environment(body.Environment)}, false, tally{})
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
	ident := sanitizeIdentity(body.Identity, now)
	var snapshot []byte
	if hasResources {
		snapshot = resourceSnapshot(sample)
	}
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

		Hostname:         ident.Hostname,
		HostnameGuess:    ident.HostnameGuess,
		ContainerID:      cmp.Or(ident.ContainerID, sample.ContainerID),
		PodName:          ident.PodName,
		PodUid:           ident.PodUID,
		Namespace:        ident.Namespace,
		NodeName:         ident.NodeName,
		Platform:         ident.Platform,
		Region:           ident.Region,
		ProcessStartTime: ident.ProcessStartTime,
		UptimeS:          body.UptimeS,
		Resources:        snapshot,
		Final:            body.Final,
	})
	if err != nil {
		e.logger.Error("store heartbeat", "error", err)
		e.fail(w, signal, errUnavailable("Could not store heartbeat, retry later"))
		return
	}
	if hasResources {
		e.submitResources(r.Context(), p.ProjectID, appID, env, instance, now, body, ident, sample)
	}
	e.inferLifecycle(r.Context(), p.ProjectID, appID, env, instance, now, ident, sample)
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
	// Counted only on the 200 that tells the SDK to reset them.
	e.flushSDKDrops(r.Context(), appID, drops)
	e.records.WithLabelValues(signal, "accepted").Inc()
	e.batches.WithLabelValues(signal, "200").Inc()
	writeJSON(w, http.StatusOK, HeartbeatAccepted{Policy: toHeartbeatPolicy(pol)})
}

// submitResources writes the heartbeat's resources to ClickHouse. The
// heartbeat's job is liveness and the capture policy, so a sink that cannot
// take the row is logged and counted, never a failed heartbeat.
func (e *Edge) submitResources(ctx context.Context, project, app uuid.UUID, env, instance string, at time.Time, body Heartbeat, ident Identity, s ResourceSample) {
	if e.sink == nil {
		return
	}
	row := pipeline.ResourceRow{
		ProjectID:    project,
		AppID:        app,
		Environment:  env,
		InstanceID:   instance,
		Timestamp:    at,
		WindowS:      float32(s.WindowS),
		Samples:      s.Samples,
		ContainerID:  cmp.Or(s.ContainerID, ident.ContainerID),
		Hostname:     ident.Hostname,
		PodName:      ident.PodName,
		Namespace:    ident.Namespace,
		NodeName:     ident.NodeName,
		Platform:     ident.Platform,
		LimitSource:  s.LimitSource,
		SDKName:      truncate(strings.TrimSpace(body.SDKName), maxSDKNameChars),
		Runtime:      truncate(strings.TrimSpace(body.Runtime), maxRuntimeChars),
		Release:      truncate(strings.TrimSpace(body.Release), maxReleaseChars),
		Metrics:      s.Metrics,
		Capabilities: s.Capabilities,
		Flags:        s.Flags,
		Processes:    s.Processes,
		Pools:        s.Pools,
	}
	if err := e.sink.SubmitResources(ctx, []pipeline.ResourceRow{row}); err != nil {
		e.records.WithLabelValues("resources", "failed").Inc()
		e.logger.Warn("store heartbeat resources", "app_id", app, "error", err)
		return
	}
	e.records.WithLabelValues("resources", "accepted").Inc()
}

// resourceSnapshot is the latest resources of an instance as stored in
// app_instances.resources: the flattened metrics plus the lists.
func resourceSnapshot(s ResourceSample) []byte {
	raw := func(v string) json.RawMessage {
		if v == "" {
			return nil
		}
		return json.RawMessage(v)
	}
	b, err := json.Marshal(struct {
		LimitSource  string             `json:"limit_source,omitempty"`
		ContainerID  string             `json:"container_id,omitempty"`
		WindowS      float64            `json:"window_s,omitempty"`
		Capabilities []string           `json:"capabilities"`
		Flags        []string           `json:"flags"`
		Metrics      map[string]float64 `json:"metrics"`
		Processes    json.RawMessage    `json:"processes,omitempty"`
		Pools        json.RawMessage    `json:"pools,omitempty"`
	}{s.LimitSource, s.ContainerID, s.WindowS, s.Capabilities, s.Flags, s.Metrics, raw(s.Processes), raw(s.Pools)})
	if err != nil {
		return nil
	}
	return b
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
			"(the app shows as reporting for 5 minutes), adds the SDK's drop counts (`dropped`) to the app's hourly counters, and answers the app's remote capture policy, which the SDK applies " +
			"until the next heartbeat. At most one heartbeat per instance every 10 seconds; a faster one answers 429 with " +
			"Retry-After. On 503 the SDK keeps its previous policy. A body with an `api_key` field at any depth is rejected with 422.",
		Tags:        []string{server.TagIngest},
		Security:    []map[string][]string{{SchemeIngestKey: {}}},
		RequestBody: &huma.RequestBody{Required: true, Content: jsonOf(body)},
		Responses: map[string]*huma.Response{
			"200": {Description: "Recorded; the body carries the capture policy", Content: jsonOf(accepted)},
			"401": errResp("Missing or invalid API key"),
			"403": errResp("API key lacks the ingest scope, may not create the app it names, is limited to other apps, or is pinned to other environments (environment_not_allowed)"),
			"409": errResp("The app was deleted less than 30 days ago; restore it from Apps"),
			"413": errResp("Body too large"),
			"422": errResp("Invalid payload or an app limit reached"),
			"429": errResp("Heartbeat of this instance less than 10 seconds after the previous one; retry after Retry-After"),
			"503": errResp("Temporarily unavailable; retry after Retry-After"),
		},
	})
}
