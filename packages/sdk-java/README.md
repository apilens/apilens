# API Lens — Java SDK

Drop-in observability for Java HTTP services. Add one dependency and API Lens
captures every request — endpoint, latency, status, payloads — attributes it to
the consumer who made it, and stitches it into a distributed trace, then streams
it to your dashboard from a background thread that never blocks your request path.

```properties
# application.properties of a Spring Boot app with apilens-java-sdk on the classpath
apilens.api-key=${APILENS_API_KEY}
apilens.app-id=orders-api
```

That is the whole setup. No agent, no sidecar, no code changes to your handlers.

---

## Table of contents

- [Install](#install)
- [The two values you need](#the-two-values-you-need)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Endpoint grouping (path templating)](#endpoint-grouping-path-templating)
- [Framework integrations](#framework-integrations)
  - [Spring MVC](#spring-mvc) · [Spring WebFlux](#spring-webflux) · [Plain Java](#plain-java)
- [Consumer attribution](#consumer-attribution)
- [Distributed tracing](#distributed-tracing)
- [Configuration reference](#configuration-reference)
- [Manual capture](#manual-capture)
- [Reliability & performance](#reliability--performance)
- [SDK health & stats](#sdk-health--stats)
- [App metadata](#app-metadata)
- [Heartbeat](#heartbeat)
- [Security & privacy](#security--privacy)
- [Troubleshooting](#troubleshooting)
- [Publishing](#publishing)
- [Support](#support)

---

## Install

Maven:

```xml
<dependency>
  <groupId>ai.apilens</groupId>
  <artifactId>apilens-java-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

Gradle:

```kotlin
implementation("ai.apilens:apilens-java-sdk:0.1.0")
```

Requires Java 17+. The only hard dependency is Jackson; Spring Boot, Spring MVC,
Spring WebFlux and Micrometer are picked up when your app already has them.

---

## The two values you need

| Value | What it is | Where to find it |
|-------|-----------|------------------|
| `apiKey` | **Project-level** key. One key works for every app in the project — the server derives the project from the key. | Project → API keys, in the [dashboard](https://app.apilens.ai). |
| `appId` | *Optional.* Name of the app (service) you're instrumenting, e.g. `"orders-api"` or `"Orders API"` — the server normalizes it to a slug and creates apps it hasn't seen. Falls back to env `APILENS_APP_ID`, then `OTEL_SERVICE_NAME`; with none set, data goes to the project's default app. The choice is logged once at INFO, e.g. `APILens: app "orders-api" (from APILENS_APP_ID)`. | Any name you choose, or the app's page in the dashboard. |

`projectSlug` is **optional** — you only pass it if you want the SDK to assert
the key belongs to a specific project. `baseUrl` defaults to
`https://ingest.apilens.ai/v1`.

> Keep the API key out of source. Read it from the environment (`APILENS_API_KEY`)
> or your secrets manager.

---

## Quick start

```properties
apilens.api-key=${APILENS_API_KEY}
apilens.app-id=orders-api
apilens.capture-profile=metadata   # metadata | redacted | full
```

The starter auto-registers a servlet filter (or a `WebFilter` in a reactive
app) when `apilens.api-key` is present. Deploy, send traffic, and requests
appear in the dashboard within a few seconds. `capture-profile=metadata` sends
no headers or bodies, the recommended first production rollout; see
[capture profiles](#capture-profiles). From here you'll typically add
[consumer attribution](#consumer-attribution) (who called each endpoint) and
lean on the automatic [distributed tracing](#distributed-tracing).

---

## How it works

```
┌─────────────────────────────────────────┐
│ your JVM                                 │
│                                          │
│  request ─▶ ApiLens filter ─▶ controller │
│                    │                     │
│            captures a record             │
│                    ▼                     │
│            in-memory queue  ──┐          │
└───────────────────────────────┼─────────┘
                                 │  background daemon thread (apilens-flush)
                                 ▼  (batch of 200, or every 3s)
                    POST /requests  ·  POST /traces  ·  POST /logs
                                 ▼
                        API Lens ingest ─▶ dashboard
```

1. **Capture is synchronous but trivial.** The filter wraps the request,
   records method, path, status, latency, byte sizes, client IP, user-agent,
   consumer identity, and (optionally) payloads/headers, then hands the finished
   record to an in-memory queue. It does not touch the network on the request path.
2. **Delivery is asynchronous.** A background daemon thread drains the queue in
   batches (default 200 records, or every 3 seconds, whichever comes first) and
   POSTs them to the ingest endpoint with retries and exponential backoff.
3. **It fails safe.** If the ingest endpoint is unreachable the queue absorbs the
   backlog up to `maxQueueSize` (default 10,000) records and `maxQueueBytes`
   (default 64 MB) and drops the **oldest** records once either is reached —
   your app keeps serving traffic regardless. Nothing the SDK does can throw
   into your handler.
4. **Requests, spans and logs share the pipeline.** Request records go to
   `/requests`, [server spans](#distributed-tracing) to `/traces` and automatic
   error logs to `/logs`, on the same batching client.

The Spring Boot auto-configuration registers the client with
`destroyMethod = "shutdown"`, so the queue is flushed when the application
context closes. With a bare client, call `client.shutdown()` (or use
try-with-resources) yourself.

---

## Endpoint grouping (path templating)

`GET /product/123` and `GET /product/324` are the **same endpoint**, so the SDK
groups them under the route template `GET /product/{id}` instead of exploding
into one endpoint per id. It does this the accurate way — by reading the
**matched route** from your framework:

| Framework | Source of the template |
| --- | --- |
| Spring MVC | `HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE` |
| Spring WebFlux (annotated controllers and router functions) | `HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE` |

The **exact URL** (`/product/123`) is preserved separately as `raw_path` and
shown in the request log — you lose nothing.

When no route matches (an unhandled URL, a plain-Java capture without a
template), the SDK falls back to a conservative heuristic that parametrizes
id-looking segments (integers, UUIDs, ULIDs, long hashes) — e.g.
`/product/123` → `/product/{id}`. Disable the fallback with
`apilens.parametrize-paths=false`, `parametrizePaths(false)`, or globally:

```bash
export APILENS_PARAMETRIZE_PATHS=false
```

---

## Framework integrations

| Framework | Class | Mechanism | Tracing |
|-----------|--------|-----------|:-------:|
| Spring Boot + Spring MVC | `ai.apilens.spring.ApiLensSpringFilter` | servlet `OncePerRequestFilter`, auto-configured | ✅ |
| Spring Boot + Spring WebFlux | `ai.apilens.spring.ApiLensWebFilter` | `WebFilter`, auto-configured | ✅ |
| Any servlet container | `ApiLensSpringFilter` | register the filter yourself | ✅ |
| Anything else | `ai.apilens.ApiLensClient` | [manual capture](#manual-capture) | manual |

### Spring MVC

Add the dependency and the two properties from the [quick start](#quick-start).
The auto-configuration (`ApiLensAutoConfiguration`) builds the client from
`apilens.*` properties and registers `ApiLensSpringFilter` at
`apilens.filter-order` (default `Integer.MAX_VALUE - 100`). Spring properties
cannot express callbacks, so register an `ApiLensSpringOptionsCustomizer` bean
for them; the auto-configuration applies every customizer (in `@Order`) on top
of the properties:

```java
@Bean
ApiLensSpringOptionsCustomizer apiLensOptions() {
  return options -> options
      .sampleRate(0.5)
      .maskRequestBody((info, body) -> info.path().startsWith("/payments") ? null : body);
}
```

Without auto-configuration, build the filter directly:

```java
var client = new ApiLensClient(ApiLensConfig.builderFromEnv().appId("orders-api").build());
var filter = new ApiLensSpringFilter(client, ApiLensSpringOptions.fromEnv(), null);
```

### Spring WebFlux

Reactive apps get `ApiLensWebFilter` instead of the servlet filter: the same
`apilens.*` properties, `ApiLensSpringOptionsCustomizer` beans, exclusions,
sampling, masking and remote policy apply. It is auto-configured when the app is
a reactive web application and `apilens.api-key` is set (the servlet filter then
backs off). Bodies are copied from the request and response `DataBuffer`
streams as they pass, up to `maxPayloadBytes`; endpoints are grouped by the
matched pattern of annotated controllers and router functions alike;
`apilens.filter-order` sets its `WebFilter` order. See
`apps/docs/setup-guides/spring-webflux.mdx` for the full guide.

### Plain Java

`ApiLensClient` is a plain Java object with no Spring dependency; see
[manual capture](#manual-capture).

---

## Consumer attribution

Attach a consumer to each request so the dashboard can break traffic down by
who called it. On Spring MVC, set it from your handler or an interceptor (a
thread-local, cleared after each request):

```java
import ai.apilens.ApiLensConsumers;

ApiLensConsumers.setConsumer("user-123", "Alice", "enterprise");
```

Or centralize it with a resolver bean, called after the handler when the
thread-local was not set:

```java
import ai.apilens.ApiLensConsumer;
import ai.apilens.spring.ApiLensConsumerResolver;
import org.springframework.context.annotation.Bean;

@Bean
ApiLensConsumerResolver apiLensConsumerResolver() {
  return (request, response) -> {
    var userId = request.getHeader("X-User-Id");
    return userId == null ? null : ApiLensConsumer.of(userId);
  };
}
```

Thread-locals do not follow a reactive request, so on WebFlux set the consumer
on the exchange, or register an `ApiLensWebFluxConsumerResolver` bean:

```java
import ai.apilens.spring.ApiLensWebFilter;

ApiLensWebFilter.setConsumer(exchange, "user-123", "Alice", "enterprise");
```

The consumer `name` and `group` are optional; `ApiLensConsumer.of(id)` sets the
identifier only.

---

## Distributed tracing

Every captured request gets a `trace_id` and a server span (`kind=server`,
named `METHOD /route/template`), sent to `/traces`. An incoming W3C
`traceparent` header is continued, so the span joins the caller's trace.

- **Current context.** `TraceContext.current()` (or `currentTraceId()`,
  `currentSpanId()`, `currentTraceparent()`) inside a Spring MVC handler; on
  WebFlux use `ApiLensWebFilter.traceContext(exchange)` (also in the Reactor
  context under `TraceContext.class`).
- **Propagating the trace.** Send `TraceContext.currentTraceparent()` as the
  `traceparent` header on outbound calls so downstream services join the trace.

### Automatic error capture

When a handler throws, or the response status is 5xx, the SDK sends one
`ERROR` log record linked to the request's trace (logger `apilens.exception`
with the stack trace as payload, or `apilens.http` for a 5xx without an
exception) and marks the span `error`. The exception is re-thrown unchanged.

### Turning tracing on and off

```properties
apilens.capture-spans=false
```

or `captureSpans(false)`, or env `APILENS_CAPTURE_SPANS=false`. Request records
keep their `trace_id` either way.

---

## Configuration reference

The option tables below list the same options, in the same order, as the
Python SDK's. An option the Java SDK does not offer is marked
**not available** with the Java way to get the same result. Java-only options
follow the shared ones.

### `ApiLensConfig`

Passed to `new ApiLensClient(ApiLensConfig.builder()...build())`, or set as
`apilens.*` [Spring properties](#spring-boot-properties) by the
auto-configuration.

| Field | Default | Description |
|-------|---------|-------------|
| `apiKey` | — (required) | Project-level API key. |
| `projectSlug` | `""` | Optional. If set, the server validates the key belongs to it. |
| `baseUrl` | `https://ingest.apilens.ai/v1` | Ingest endpoint. |
| `environment` | `"production"` | Environment label (lower-cased). |
| `batchSize` | `200` | Records per POST (also the flush trigger). Backend max is 1000. |
| `maxBatchBytes` | `4 * 1024 * 1024` | Byte cap on one POST's JSON body (uncompressed). A batch is cut at `batchSize` records or `maxBatchBytes`, whichever comes first. Minimum 1 KB; keep it under the ingest edge's 16 MB limit. See [reliability](#reliability--performance). |
| `flushInterval` | `Duration.ofSeconds(3)` | Time between automatic flushes. |
| `mode` | **not available** | Python only. The Java client always flushes from a background thread; in short-lived processes call `client.flushAll()` before exiting. |
| `timeout` | `Duration.ofSeconds(5)` | Per-request HTTP timeout. |
| `maxQueueSize` | `10_000` | Record cap per queue; oldest records drop once full. |
| `maxQueueBytes` | `64 * 1024 * 1024` | Memory cap shared by the request, span and log queues (estimated bytes); oldest records drop once exceeded. |
| `maxRetries` | `3` | Retry attempts per batch for 408, 429, 5xx and network errors (full-jitter exponential backoff, or the server's `Retry-After`). |
| `compress` | `true` | gzip each batch (`Content-Encoding: gzip`) on the background flush thread. `false` sends plain JSON. |
| `verifyTls` | `true` | Verify the ingest server's TLS certificate. |
| `caBundlePath` | `""` | Custom CA bundle (PEM) for TLS verification; replaces the system trust store. |
| `proxyUrl` | **not available** | Python only. Configure egress through your network (e.g. a transparent proxy); see [network requirements](#network-requirements). |
| `enabled` | `true` | Master switch; `false` disables capture and the worker entirely. |
| `sendMetadata` | `true` | Report framework, versions, route templates and the effective capture config once per process (`POST /v1/metadata`). Env `APILENS_SEND_METADATA=false` also turns it off. See [App metadata](#app-metadata). |
| `sendHeartbeat` | `true` | Send `POST /v1/heartbeat` on start, every `heartbeatInterval` and on shutdown; its response carries the remote capture policy. Env `APILENS_SEND_HEARTBEAT=false` also turns it off. See [Heartbeat](#heartbeat). |
| `heartbeatInterval` | `Duration.ofSeconds(60)` | Time between heartbeats. Minimum 10 s (ingest answers 429 to faster ones). |
| `appId` | `APILENS_APP_ID` → `OTEL_SERVICE_NAME` → `""` | App the records and heartbeats belong to (free-form name). Empty: records go to the project's default app and no heartbeat/metadata is sent. |
| `onStats` | **not available** | Python only. Read `client.stats()` yourself, or let the [Micrometer binder](#sdk-health--stats) export it. |
| `release` / `commit` | detected | Release and commit sent with the heartbeat. Fall back to `APILENS_RELEASE` / `APILENS_COMMIT`, `GIT_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`. |
| `retryBackoffBase` / `retryBackoffMax` | `250ms` / `5s` | Full-jitter backoff bounds. |
| `userAgent` | `apilens-java-sdk/<version>` | User-Agent of ingest requests. |
| `ingestPath` / `spansPath` / `logsPath` | `requests` / `traces` / `logs` | Paths under `baseUrl` for the three record kinds. |
| `heartbeatPath` / `metadataPath` | `heartbeat` / `metadata` | Paths under `baseUrl` for heartbeats and the metadata report. |

### Capture profiles

`captureProfile` picks a whole capture posture in one greppable word, with the
same names and semantics as the Python and TypeScript SDKs. It sets the
*defaults* of the capture flags below; any flag you set explicitly (a builder
call, its own `APILENS_*` env var or Spring property) wins over the preset.

| Profile | Headers | Request / response bodies | Validation errors | Body cap |
|---|---|---|---|---|
| `metadata` | off | off | not captured by the Java SDK | — |
| `redacted` | on, sensitive values masked | on, [default masking](#masking) | not captured by the Java SDK | 16 KB |
| `full` (default) | on, sensitive values masked | on, [default masking](#masking) | not captured by the Java SDK | 64 KB |

Under every profile the base record (method, route, status, latency, sizes,
consumer, IP, user agent, trace id) is sent, so dashboards and metrics stay
exact, and the built-in masking patterns always apply.

**Default posture.** Without a profile the SDK behaves as `full`, unchanged for
backwards compatibility. For a **first production rollout we recommend
`metadata`**; move to `redacted` once you have checked what your payloads
contain.

```properties
apilens.capture-profile=metadata
# Individual flags win over the preset: request bodies only.
apilens.log-request-body=true
```

Under `metadata`, `capture-payloads=true` asks for both bodies. In code, call
`ApiLensSpringOptions.builder().captureProfile(CaptureProfile.METADATA)` (or
set it from an `ApiLensSpringOptionsCustomizer`). Env var:
`APILENS_CAPTURE_PROFILE=metadata`. Precedence: explicit flag > the flag's env
var / Spring property > `captureProfile` > default. An unknown profile name
fails at startup.

### Filter options

`ApiLensSpringOptions`, accepted by `ApiLensSpringFilter` and `ApiLensWebFilter`
(`ApiLensSpringOptions.builder()`, `fromEnv()`, or `apilens.*` properties plus
`ApiLensSpringOptionsCustomizer` beans under Spring Boot).

| Option | Default | Description |
|--------|---------|-------------|
| `appId` | client's | Taken from `ApiLensConfig.appId` (optional; see above). |
| `environment` | `"production"` | Environment label on records, spans and logs. |
| `captureProfile` | `null` (= `full`) | `METADATA`, `REDACTED` or `FULL`; sets the defaults of the capture flags (see [capture profiles](#capture-profiles)). |
| `capturePayloads` | `true` | Capture request/response bodies (size-limited). |
| `captureHeaders` | `true` | Capture request/response headers (sensitive values redacted). |
| `logRequestBody` / `logResponseBody` | `true` | Toggle each body independently. |
| `maxPayloadBytes` | `65536` | Per-body capture cap; set `0` to disable body capture. |
| `captureValidationErrors` | **not available** | Python only. 400/422 bodies are captured as ordinary response bodies. |
| `captureContentTypes` | **not available** | Python only. The captured types are fixed: `application/json`, `*+json`, `text/*`, `application/x-www-form-urlencoded`; see [body capture](#body-capture-and-mask-callbacks). |
| `captureSpans` | `true` | Emit a server span (and the automatic error log) per request. |
| `serviceName` | `appId` | Service name shown on spans. |
| `getConsumer` | — | Register an `ApiLensConsumerResolver` (MVC) or `ApiLensWebFluxConsumerResolver` (WebFlux) bean, or pass it to the filter constructor (see [consumer attribution](#consumer-attribution)). |
| `maskRequestBody` / `maskResponseBody` | `null` | `BiFunction<RequestInfo/ResponseInfo, byte[], byte[]>` callbacks on the captured (truncated) raw body; see [body mask callbacks](#body-capture-and-mask-callbacks). |
| `flushOnShutdown` | always | The Spring bean's destroy method (`client.shutdown()`) flushes the queue when the context closes; outside Spring call `client.shutdown()` yourself. |
| `shutdownTimeout` | **not available** | Python only. The shutdown flush has no separate bound; each batch it sends is bounded by `timeout` and `maxRetries`. |
| `excludePaths` | `[]` | Regexes for paths to skip entirely (no record, span or log), e.g. `^/health$`. Matched case-insensitively against the path without query string. `APILENS_EXCLUDE_PATHS` (comma-separated env var) adds to it. An invalid regex fails at startup. |
| `excludeUserAgents` | `[]` | Regexes for `User-Agent` values to skip entirely, e.g. `^uptimerobot`. Case-insensitive search. `APILENS_EXCLUDE_USER_AGENTS` (comma-separated env var) adds to it. |
| `defaultExclusions` | `true` | Skip the [built-in health/probe exclusions](#default-exclusions) (applied before `excludePaths`). `false` turns them off; your own `excludePaths` / `excludeUserAgents` still apply. |
| `sampleRate` | `1.0` | Fraction (0.0–1.0) of requests whose detail — headers, bodies, span, auto error log — is kept. See [sampling](#sampling). A value outside the range fails at startup. |
| `sampleOnRequest` | `null` | `RequestSampler` evaluated before the handler; overrides `sampleRate` per request. See [sampling](#sampling). |
| `sampleOnResponse` | `null` | `ResponseSampler` evaluated after the response; can drop a kept request's detail, never un-drop one. See [sampling](#sampling). |
| `enabled` | `true` | `false` makes the filter pass every request through untouched. |
| `enableRequestLogging` | `true` | `false` turns off header and body capture. |
| `redactQueryParams` / `redactHeaders` / `redactBodyFields` | `[]` | Extra masking regexes; the built-ins always apply (see [masking](#masking)). |
| `parametrizePaths` | `true` | Fall back to the id heuristic when no route template matched (see [endpoint grouping](#endpoint-grouping-path-templating)). |
| `captureIp` / `anonymizeIp` | `true` / `false` | Client IP privacy (see [client IP privacy](#client-ip-privacy)). |

### Sampling

Sampling never changes metrics. Every request still sends its base record
(method, route, status, latency, sizes, consumer, trace id), so traffic, error
and latency charts stay exact. A sampled-out request only loses its detail:
headers, bodies, its span and its automatic error log, and its record carries
`sampled: false`. Its request body is never buffered. The trace context is
still propagated to the handler and downstream services, so they can decide
independently.

`sampleRate` (`0.0`–`1.0`, default `1.0`) is the fraction of requests whose
detail is kept. Two callbacks refine it, each returning a `SampleDecision`:
`KEEP`, `DROP`, `SampleDecision.probability(p)` or `UNDECIDED`.

- `sampleOnRequest` (`RequestSampler`) runs before the handler, with a
  `RequestInfo` (`method`, `path`, `rawPath`, `headers`, `userAgent()`). A
  request it drops is final, and its body is never buffered. `UNDECIDED` falls
  back to `sampleRate`.
- `sampleOnResponse` (`ResponseSampler`) runs after the handler, with a
  `SampleResponseInfo` (`request`, `route`, `statusCode`, `responseTimeMs`,
  `consumer`, `requestDecision`). It can drop a request but cannot keep one the
  request stage dropped. `UNDECIDED` keeps the prior decision. When it is set,
  the `sampleRate` roll for requests the request stage left undecided happens
  after it, so it can keep every error even at a low rate.

A callback that throws or returns `null` counts as `UNDECIDED` (logged once);
exceptions never reach the handler.

```java
@Bean
ApiLensSpringOptionsCustomizer apiLensSampling() {
  return options -> options
      .sampleRate(0.1)
      // Never keep detail for internal endpoints.
      .sampleOnRequest(request -> request.path().startsWith("/internal/")
          ? SampleDecision.DROP
          : SampleDecision.UNDECIDED)
      // Keep every server error; everything else follows sampleRate.
      .sampleOnResponse(response -> response.statusCode() >= 500
          ? SampleDecision.KEEP
          : SampleDecision.UNDECIDED);
}
```

### Default exclusions

Unless `defaultExclusions(false)` (`apilens.default-exclusions=false`),
requests matching any of these are skipped entirely: the request and response
are not wrapped, no body is buffered, and no record, span or log is sent. They
are checked before `excludePaths`. All patterns are case-insensitive regex
searches; `^` / `$` anchor to the path, which is matched without the query
string (so `^/health$` excludes `/health` but not `/healthz` or `/api/health`).
Patterns are compiled when the filter is created, so an invalid regex fails at
startup, never per request.

Paths (`RequestExcluder.DEFAULT_EXCLUDED_PATHS`):

```
/_?healthz?$
/_?health[-_]?checks?$
/_?heart[-_]?beats?$
/ping$
/ready$
/live$
/favicon(?:-[\w-]+)?\.(?:ico|png|svg)$
/apple-touch-icon(?:-[\w-]+)?\.png$
/robots\.txt$
/sitemap\.xml$
/manifest\.json$
/site\.webmanifest$
/service-worker\.js$
/sw\.js$
/\.well-known/
```

User agents (`RequestExcluder.DEFAULT_EXCLUDED_USER_AGENTS`):

```
health[-_ ]?check
microsoft-azure-application-lb
googlehc
kube-probe
```

Add your own, or turn the defaults off:

```properties
apilens.exclude-paths[0]=^/internal/
apilens.exclude-paths[1]=^/status$
apilens.exclude-user-agents[0]=uptimerobot
# false records health checks and probes again
apilens.default-exclusions=true
```

Comma-separated values (`apilens.exclude-paths=^/internal/,^/status$`) also
work; use the indexed form for a regex that contains a comma (`\d{1,3}`).

### Environment variables

`ApiLensConfig.fromEnv()` (client) and `ApiLensSpringOptions.fromEnv()`
(capture options) read the same `APILENS_*` variables as the Python and
TypeScript SDKs, so a rollout or a kill switch needs no code change:

```java
var client = new ApiLensClient(ApiLensConfig.builderFromEnv()
    .appId("orders-api") // explicit setters win over the environment
    .build());
var filter = new ApiLensSpringFilter(client, ApiLensSpringOptions.fromEnv(), null);
```

Precedence: **explicit setter > env var > capture profile > default**
(`builderFromEnv()` pre-fills a builder; setters called on it afterwards
win). Booleans accept `1`/`0`/`true`/`false` (also `yes`/`no`/`on`/`off`, any
case). Lists are comma-separated (`APILENS_REDACT_BODY_FIELDS=^password$,^ssn$`);
a regex that needs a literal comma must be passed as a list in code. Durations
are seconds and may be fractional. Unset or empty variables are ignored; an
unparseable value throws `IllegalArgumentException` naming the variable.
`ApiLensEnv` exposes the parser. Under Spring Boot the same names bind to the
matching `apilens.*` properties (`APILENS_SAMPLE_RATE` to
`apilens.sample-rate`) with Spring's usual precedence, where an OS environment
variable overrides `application.properties`.

| Variable | Option | Type | Default |
|---|---|---|---|
| `APILENS_API_KEY` | `apiKey` | string | — (required) |
| `APILENS_APP_ID` | `appId` | string | `OTEL_SERVICE_NAME`, else `""` (default app) |
| `APILENS_PROJECT_SLUG` | `projectSlug` | string | `""` |
| `APILENS_ENVIRONMENT` | `environment` | string | `"production"` |
| `APILENS_BASE_URL` | `baseUrl` | string | `https://ingest.apilens.ai/v1` |
| `APILENS_ENABLED` | `enabled` | bool | `true` |
| `APILENS_CAPTURE_PROFILE` | `captureProfile` | `metadata`, `redacted` or `full` | none (= `full`) |
| `APILENS_CAPTURE_HEADERS` | `captureHeaders` | bool | `true` |
| `APILENS_CAPTURE_PAYLOADS` | `capturePayloads` | bool | `true` |
| `APILENS_LOG_REQUEST_BODY` | `logRequestBody` | bool | `true` |
| `APILENS_LOG_RESPONSE_BODY` | `logResponseBody` | bool | `true` |
| `APILENS_MAX_PAYLOAD_BYTES` | `maxPayloadBytes` | int | `65536` |
| `APILENS_CAPTURE_VALIDATION_ERRORS` | **not available** | — | — |
| `APILENS_CAPTURE_CONTENT_TYPES` | **not available** | — | — |
| `APILENS_REDACT_QUERY_PARAMS` | `redactQueryParams` | list | none (built-ins always apply) |
| `APILENS_REDACT_HEADERS` | `redactHeaders` | list | none (built-ins always apply) |
| `APILENS_REDACT_BODY_FIELDS` | `redactBodyFields` | list | none (built-ins always apply) |
| `APILENS_EXCLUDE_PATHS` | `excludePaths` | list, **added to** the configured value | none |
| `APILENS_EXCLUDE_USER_AGENTS` | `excludeUserAgents` | list, **added to** the configured value | none |
| `APILENS_DEFAULT_EXCLUSIONS` | `defaultExclusions` | bool | `true` |
| `APILENS_SAMPLE_RATE` | `sampleRate` | double 0.0–1.0 | `1.0` |
| `APILENS_CAPTURE_IP` | `captureIp` | bool; `false` wins over code | `true` |
| `APILENS_ANONYMIZE_IP` | `anonymizeIp` | bool; `true` wins over code | `false` |
| `APILENS_CAPTURE_SPANS` | `captureSpans` | bool | `true` |
| `APILENS_BATCH_SIZE` | `batchSize` | int | `200` |
| `APILENS_FLUSH_INTERVAL` | `flushInterval` | seconds | `3` |
| `APILENS_MODE` | **not available** | — | — |
| `APILENS_TIMEOUT` | `timeout` | seconds | `5` |
| `APILENS_VERIFY_TLS` | `verifyTls` | bool | `true` |
| `APILENS_CA_BUNDLE_PATH` | `caBundlePath` | string | `""` |
| `APILENS_MAX_QUEUE_SIZE` | `maxQueueSize` | int | `10000` |
| `APILENS_MAX_QUEUE_BYTES` | `maxQueueBytes` | long | `67108864` |
| `APILENS_MAX_BATCH_BYTES` | `maxBatchBytes` | int | `4194304` |
| `APILENS_COMPRESS` | `compress` | bool | `true` |
| `APILENS_MAX_RETRIES` | `maxRetries` | int | `3` |
| `APILENS_SERVICE_NAME` | `serviceName` | string | app id |
| `APILENS_SEND_HEARTBEAT` | `sendHeartbeat` | bool; `false` wins over code | `true` |
| `APILENS_SEND_METADATA` | `sendMetadata` | bool; `false` wins over code | `true` |
| `APILENS_PARAMETRIZE_PATHS` | `parametrizePaths` | bool; `false` wins over code | `true` |
| `APILENS_RELEASE` / `APILENS_COMMIT` | `release` / `commit` | string | detected |

`APILENS_EXCLUDE_PATHS` / `APILENS_EXCLUDE_USER_AGENTS` are added by the
filter to whatever is configured, with or without Spring.
`APILENS_CAPTURE_IP=false`, `APILENS_ANONYMIZE_IP=true` and
`APILENS_PARAMETRIZE_PATHS=false` are kill switches: they win over code, but
only in the direction that captures less.

### Spring Boot properties

The Java counterpart of Python's Django settings. Properties use the
`apilens.*` prefix; the jar ships `META-INF/spring-configuration-metadata.json`,
so IntelliJ, VS Code and Eclipse complete every property below with its
description and default.

| Property | Default | Description |
|---|---|---|
| `apilens.api-key` | required | Project API key; auto-configuration is enabled only when it is set. |
| `apilens.app-id` | empty | App name (optional; falls back to `APILENS_APP_ID`, then `OTEL_SERVICE_NAME`, then the project's default app). |
| `apilens.project-slug` | empty | Optional project assertion. |
| `apilens.base-url` | `https://ingest.apilens.ai/v1` | Ingest endpoint. |
| `apilens.ingest-path` / `apilens.spans-path` / `apilens.logs-path` | `requests` / `traces` / `logs` | Paths under the base URL. |
| `apilens.environment` | `production` | Environment label (lower-cased). |
| `apilens.release` / `apilens.commit` | detected | Fall back to `APILENS_RELEASE` / `APILENS_COMMIT`, `GIT_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`. |
| `apilens.batch-size` | `200` | Records per ingest request (1–1000). |
| `apilens.flush-interval` | `3s` | Interval between background flushes. |
| `apilens.timeout` | `5s` | HTTP timeout for one ingest request. |
| `apilens.verify-tls` / `apilens.ca-bundle-path` | `true` / empty | TLS verification of the ingest endpoint. |
| `apilens.max-queue-size` | `10000` | Records per queue (requests, spans, logs). |
| `apilens.max-queue-bytes` | `67108864` (64 MB) | Estimated bytes all three queues may hold together. |
| `apilens.max-batch-bytes` | `4194304` (4 MB) | Upper bound on one ingest request body (min `1024`). |
| `apilens.compress` | `true` | Gzip batch bodies. |
| `apilens.max-retries` | `3` | Retries for 408, 429, 5xx and network errors. |
| `apilens.retry-backoff-base` / `apilens.retry-backoff-max` | `250ms` / `5s` | Full-jitter backoff bounds. |
| `apilens.enabled` | `true` | Master switch: `false` sends nothing. |
| `apilens.user-agent` | `apilens-java-sdk/<version>` | User-Agent of ingest requests. |
| `apilens.send-heartbeat` | `true` | Send `POST /v1/heartbeat`; see [Heartbeat](#heartbeat). |
| `apilens.heartbeat-interval` | `60s` | Time between heartbeats (at least `10s`). |
| `apilens.send-metadata` | `true` | Send the [app metadata](#app-metadata) report once the app is ready. |
| `apilens.enable-request-logging` | `true` | `false` turns off header and body capture. |
| `apilens.capture-profile` | unset (= `full`) | `metadata`, `redacted` or `full`; see [Capture profiles](#capture-profiles). |
| `apilens.log-request-body` | `true`* | Capture request bodies. |
| `apilens.log-response-body` | `true`* | Capture response bodies. |
| `apilens.capture-payloads` | `true`* | Capture request/response bodies. |
| `apilens.capture-headers` | `true`* | Capture request/response headers (redacted). |
| `apilens.capture-spans` | `true` | Emit a server span per request. |
| `apilens.service-name` | app id | Service name on spans. |
| `apilens.max-payload-bytes` | `65536`* | Body capture cap; `0` disables bodies. |
| `apilens.redact-query-params` | empty | Extra query-param name regexes; built-ins always apply. |
| `apilens.redact-headers` | empty | Extra header name regexes; built-ins always apply. |
| `apilens.redact-body-fields` | empty | Extra JSON/form field name regexes; built-ins always apply. |
| `apilens.parametrize-paths` | `true` | Group raw paths into route templates. |
| `apilens.capture-ip` | `true` | `false` sends no client IP. |
| `apilens.anonymize-ip` | `false` | Truncate IPv4 to /24, IPv6 to /48. |
| `apilens.exclude-paths` | empty | Path regexes of requests not captured at all. |
| `apilens.exclude-user-agents` | empty | User-Agent regexes of requests not captured at all. |
| `apilens.default-exclusions` | `true` | Built-in health-check/probe/static-file exclusions. |
| `apilens.sample-rate` | `1.0` | Fraction of requests whose detail is kept. |
| `apilens.filter-order` | `Integer.MAX_VALUE - 100` | Servlet filter / `WebFilter` order. |

\* The default applies only when `apilens.capture-profile` does not set the
flag.

**Local development:** point the SDK at a local ingest with
`apilens.base-url=http://localhost:<port>/v1`, and set `apilens.verify-tls=false`
if you're using a self-signed certificate.

---

## Manual capture

For non-HTTP workloads (batch jobs, workers, custom protocols) use the client
directly. It is safe to share one client across threads.

```java
import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.RequestRecord;

try (var client = new ApiLensClient(ApiLensConfig.builder()
    .apiKey(System.getenv("APILENS_API_KEY"))
    .appId("orders-api")
    .build())) {
  client.capture(RequestRecord.builder()
      .method("POST")
      .path("/internal/reconcile")
      .rawPath("/internal/reconcile")
      .statusCode(200)
      .responseTimeMs(24.5)
      .build());
} // flushed on close
```

`client.captureSpan(SpanRecord)` and `client.captureLog(LogRecord)` queue spans
and logs the same way. try-with-resources flushes on exit; otherwise call
`client.shutdown()` before your process ends. `client.droppedCount()` reports
records shed under backpressure and `client.dropCounts()` breaks that total
down by reason (see [Reliability & performance](#reliability--performance)).

---

## Reliability & performance

Sizing the queue and batches for your traffic, the memory math, shutdown,
serverless and proxies are covered end to end in the
[Delivery reference](https://apilens.ai/docs/sdk-reference/delivery).

- **Non-blocking.** Capture only enqueues; all I/O happens on the
  `apilens-flush` daemon thread. Ingest latency and outages never slow or fail
  your requests.
- **Bounded memory.** Queued records are capped both by count (`maxQueueSize`,
  10,000 per queue) and by size (`maxQueueBytes`, 64 MB, estimated, shared by
  the request, span and log queues). Whichever limit is hit first, the oldest
  records are dropped rather than the queue growing without limit.
- **Drop accounting.** `client.droppedCount()` is the total;
  `client.dropCounts()` returns it by reason:

  | Reason | Meaning |
  |---|---|
  | `queue_full` | The queue reached `maxQueueSize`; the oldest record was dropped. |
  | `queue_bytes` | Queued bytes would exceed `maxQueueBytes`; the oldest record(s) were dropped. |
  | `non_retryable` | Ingest rejected the batch with a 4xx other than 408/429; it is not retried. |
  | `retries_exhausted` | The batch still failed (network, timeout, 408, 429, 5xx) after `maxRetries`. |
  | `truncated` | Not a drop: one record was larger than `maxBatchBytes` on its own, so its payloads were cut before sending. Not counted in `droppedCount()`. |

- **Size-bounded batches.** A POST is cut at `batchSize` records or
  `maxBatchBytes` (default 4 MB, measured on the uncompressed JSON), whichever
  comes first, so a backlog of large records goes out as several requests
  instead of one oversized body that ingest would reject whole. A single record
  over the cap is truncated (payloads first) rather than dropped.
- **Resilient delivery.** 408, 429, 5xx, timeouts and network errors retry up to
  `maxRetries` times with full-jitter exponential backoff (between
  `retryBackoffBase` and `retryBackoffMax`), so many instances do not retry in
  lockstep. A `Retry-After` header takes precedence, capped at 60 s. Any other
  4xx drops the batch immediately; a 401 logs one clear message.
- **Never throws into your app.** All SDK errors are caught and logged under
  the `java.util.logging` logger `apilens` — raise it to `FINE` while
  debugging.
- **Graceful shutdown.** Under Spring Boot the client bean's destroy method
  flushes the queue and sends the final heartbeat.

---

## SDK health & stats

`client.stats()` returns a `ClientStats` snapshot of the delivery pipeline. It
is thread-safe and cheap, so it is fine to call from a health or metrics
endpoint.

| Field | Meaning |
|---|---|
| `queuedRecords` | Records waiting in the request, span and log queues. |
| `queuedBytes` | Estimated size of those records (bounded by `maxQueueBytes`). |
| `sentBatches` / `sentRecords` | Batches and records ingest accepted (2xx), since start. |
| `failedBatches` | Batches dropped after a non-retryable 4xx or after `maxRetries`. |
| `dropCounts` | Records dropped, by reason (same keys as `client.dropCounts()`). |
| `droppedCount` | Sum of `dropCounts`, excluding `truncated` (those were still sent). |
| `lastError` | The most recent ingest failure; empty until one happens. |
| `lastSuccessAt` | `Instant` of the last accepted batch, or `null`. |

**Exporting.** With `micrometer-core` on the classpath, Spring Boot registers an
`ApiLensMetrics` binder automatically (outside Spring, call
`new ApiLensMetrics(client).bindTo(registry)`):

| Meter | Type |
|---|---|
| `apilens.queue.records` | gauge |
| `apilens.queue.bytes` | gauge |
| `apilens.batches.sent`, `apilens.records.sent` | counter |
| `apilens.batches.failed` | counter |
| `apilens.records.dropped{reason}` | counter |
| `apilens.records.truncated` | counter |

**Rollout checklist.** After deploying, confirm `lastSuccessAt` advances and
`sentRecords` grows; `failedBatches` or `droppedCount` rising with a non-empty
`lastError` points at the cause (a 401 means a bad key; network errors mean
egress is blocked, see [Network requirements](#network-requirements)).

---

## App metadata

When the Spring application is ready, the SDK sends `POST /v1/metadata` once per
process. The dashboard uses it to list endpoints that have had no traffic yet
and to show the SDK config the app actually runs with.

- **Contents:** `framework` (`spring-boot`), `framework_version`,
  `spring_version`, `java_version`, `sdk_version`, the route templates of every
  Spring MVC `RequestMappingHandlerMapping` and WebFlux `@RequestMapping` (at
  most 2000; a mapping without a method condition is reported as `*`) and the
  effective capture config (masking patterns and exclusions including the
  built-ins, sample rate, delivery settings; callbacks only as
  `true`/`false`).
- **Never sent:** the API key, the CA bundle path, callback details.
- **Failures:** 408/429/5xx are retried up to 3 times; requests are never
  affected.
- **Turn it off:** `apilens.send-metadata=false` (`sendMetadata(false)`), or
  env `APILENS_SEND_METADATA=false`. Outside Spring, call
  `client.reportMetadata(environment, () -> body)`.

The full contract is in the ingest docs (`apps/docs/ingest/heartbeat.mdx`).

---

## Heartbeat

A daemon thread (`apilens-heartbeat`) sends `POST /v1/heartbeat` for the app:
once on start, then every `heartbeatInterval` (default 60 s, at least 10 s),
and once more with `"final": true` when the client shuts down (the Spring bean's
destroy method). APILens uses it for app status and uptime.

- **Body:** `app_id`, `environment` (the filter's), `instance_id` (a UUID per
  client, `client.instanceId()`), `sdk_name` (`apilens-java-sdk`),
  `sdk_version`, `runtime` (`java 21.0.5`), `pid`, `uptime_s`, `release`,
  `commit`, `project_slug` and `stats` (the `client.stats()` snapshot). Never
  the API key.
- **Failures are silent:** no retries; 401/403/422 are logged once at WARNING,
  everything else at FINE; 429/503 wait for `Retry-After`. Record delivery is
  never affected.
- **Turn it off:** `apilens.send-heartbeat=false` (`sendHeartbeat(false)`), or
  env `APILENS_SEND_HEARTBEAT=false`.

### Remote capture policy

The heartbeat response carries the app's capture policy, `client.remotePolicy()`
(`RemotePolicy.CAPTURE_EVERYTHING` until the first heartbeat succeeds; a failed
heartbeat keeps the previous one). The filter applies it from the next request,
so a change in APILens reaches the app within one heartbeat interval. It can only
**narrow** capture, never widen what the local options allow:

| Policy field | Effect |
|---|---|
| `enabled: false` | No request, span or log records are sent; the filter bypasses requests. Heartbeats continue. |
| `sample_rate` | Keeps that fraction of the requests local sampling keeps; the rest send only the base record (`sampled: false`). |
| `capture_headers`, `capture_request_body`, `capture_response_body` | `false` turns that part off; `true` never turns on what is off locally. |
| `max_payload_bytes` | The smaller of it and `maxPayloadBytes`; `null` keeps the local cap. |

---

## Security & privacy

### Masking

Values are replaced with `[redacted]`; names stay visible. Built-in patterns
are always applied, with no configuration, and your patterns extend them
(they never replace them). Every pattern is a case-insensitive regex searched
for in the query-parameter, header or JSON/form field *name*:

| List | Built-in patterns |
|---|---|
| Query params (`Redactor.DEFAULT_MASK_QUERY_PARAMS`) | `auth`, `api.?key`, `secret`, `token`, `password`, `pwd` |
| Headers (`Redactor.DEFAULT_MASK_HEADER_PATTERNS`) | `auth`, `api.?key`, `secret`, `token`, `cookie` |
| Body fields (`Redactor.DEFAULT_MASK_BODY_FIELDS`) | `password`, `pwd`, `token`, `secret`, `auth`, `card.?number`, `ccv`, `cvv`, `cvc`, `ssn` |

The exact header names `authorization`, `proxy-authorization`, `cookie`,
`set-cookie`, `x-api-key`, `api-key`, `x-auth-token`, `x-amz-security-token`
and `x-csrf-token` are also always redacted. So `?token=abc` is captured as
`?token=[redacted]` out of the box.

A matching body field is masked when its value is a string, a number, or a
nested object/array (masked whole); booleans and `null` stay visible. A body or
query with nothing to mask is sent unchanged. Add your own patterns (anchor for
an exact match):

```properties
apilens.redact-query-params[0]=^card_number$
apilens.redact-headers[0]=x-private-.*
apilens.redact-body-fields[0]=^iban$
```

An invalid regex fails at startup with a `PatternSyntaxException`.

### Client IP privacy

```properties
apilens.capture-ip=true     # false: no client IP is sent at all
apilens.anonymize-ip=false  # true: IPv4 truncated to /24, IPv6 to /48
```

The IP is taken from the first `X-Forwarded-For` entry, then `X-Real-IP`, then
the socket address. With `anonymize-ip`, `203.0.113.42` is sent as
`203.0.113.0` and `2001:db8:85a3:8d3::1` as `2001:db8:85a3::`; IPv4-mapped IPv6
is treated as IPv4, and a value that is not a parseable IP is dropped. The
`APILENS_CAPTURE_IP=false` and `APILENS_ANONYMIZE_IP=true` environment
variables tighten this per deployment and cannot loosen what is configured.
Outside Spring, `IpPrivacy.apply(ip, captureIp, anonymizeIp)` applies the same
policy.

### Body capture and mask callbacks

Only JSON (`application/json`, `*+json`), `text/*` and
`application/x-www-form-urlencoded` bodies are captured. Any other content
type (multipart uploads, images, PDFs, a body with no `Content-Type`) is stored
as a placeholder such as `[multipart/form-data, 2048 bytes omitted]`.
Form-encoded bodies are masked with the query redactor: a field is redacted
when its name matches `redact-query-params` or `redact-body-fields`.

`maskRequestBody` / `maskResponseBody` handle what field patterns can't (XML,
free text, card numbers inside values). Each is a `BiFunction` called with a
`RequestInfo` (`method`, `path`, `rawPath`, `headers`, `contentType()`) or a
`ResponseInfo` (`request`, `statusCode`, `headers`, `contentType()`) and the
captured bytes (truncated to `maxPayloadBytes`); return the bytes to store.
The order is fixed: callback, then the regex masking, so the patterns still
apply to whatever the callback returns. Fail closed: returning `null` or
throwing stores the whole body as `[masked]`, never the raw body. Callbacks are
not called for bodies that are not captured.

```java
@Bean
ApiLensSpringOptionsCustomizer apiLensBodyMasking() {
  return options -> options
      .maskRequestBody((info, body) -> {
        if (info.path().startsWith("/payments")) {
          return null; // stored as [masked]
        }
        return body;
      })
      .maskResponseBody((info, body) -> info.statusCode() >= 400 ? body : null);
}
```

Without auto-configuration, pass the callbacks to
`ApiLensSpringOptions.builder()` directly.

### Network requirements

The SDK only makes outbound HTTPS requests to `baseUrl`
(`https://ingest.apilens.ai/v1` by default): `POST /requests`, `/traces`,
`/logs`, `/heartbeat` and `/metadata`, authenticated with the `X-API-Key`
header. Allow egress to that host on port 443. A custom CA (for a
TLS-intercepting proxy) goes in `caBundlePath`.

---

## Troubleshooting

**Nothing appears in the dashboard.**
1. Confirm `apilens.api-key` is set (the auto-configuration is skipped without
   it) and belongs to the expected project.
2. Check which app the data goes to: the startup log line `APILens: app ...`.
3. Confirm `apilens.base-url` is correct (default `https://ingest.apilens.ai/v1`).
4. Raise the `apilens` `java.util.logging` logger to `FINE` (with Spring Boot:
   `logging.level.apilens=DEBUG`).
5. Allow a few seconds for the batching interval before data shows up.

**`422 Unprocessable Entity` from ingest.** Check the record fields; `app-id` itself
is free-form (an unseen name creates the app).

**`401 Unauthorized`.** The API key is missing, revoked, or not project-scoped.

**Requests appear under raw paths.** The route template comes from Spring's
matched pattern; requests that no handler matched fall back to the id
heuristic (see [endpoint grouping](#endpoint-grouping-path-templating)).

---

## Publishing

The Maven project is configured for Maven Central's Central Publisher Portal.
With Central token credentials under server id `central` and GPG signing
available, publish with:

```bash
cd packages/sdk-java
mvn -P release deploy
```

The repository workflow `Publish Java SDK to Maven Central` runs the same
release profile from tags named `apilens-java-sdk-vX.Y.Z`.

---

## Support

- Documentation — https://apilens.ai/docs
- Email — hello@apilens.ai
- Issues — https://github.com/apilens/apilens/issues

MIT licensed.
