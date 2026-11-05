# API Lens JavaScript SDK

JavaScript SDK for API Lens with an Express-first middleware API.

## Install

```bash
npm install apilens-js-sdk
```

For local workspace testing:

```bash
npm install ./packages/sdk-typescript
```

## Quick start

```js
import express from "express";
import { useApiLens, setConsumer } from "apilens-js-sdk/express";

const app = express();
app.use(express.json());

useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  baseUrl: "https://ingest.apilens.ai/v1",
  environment: "production",
  requestLogging: {
    maxPayloadBytes: 8192,
  },
});

app.get("/v1/orders", (req, res) => {
  setConsumer(req, { id: "user_123", name: "Demo User", group: "starter" });
  res.json({ ok: true });
});

process.on("SIGTERM", async () => {
  await app.apilensClient?.handleShutdown({ flush: true });
  process.exit(0);
});
```

## Manual capture

```js
import { ApiLensClient } from "apilens-js-sdk";

const client = new ApiLensClient({
  apiKey: "your_app_api_key",
  baseUrl: "https://ingest.apilens.ai/v1",
  environment: "production",
});

client.capture({
  method: "GET",
  path: "/health",
  status_code: 200,
  response_time_ms: 12.4,
});

await client.handleShutdown({ flush: true });
```

## Header capture

Request and response headers are captured by default and sent as
`request_headers` / `response_headers`: a compact JSON object with lower-cased
names, the same wire format as the Python and Java SDKs.

- Values of built-in sensitive headers are always replaced with `[redacted]`:
  `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `api-key`, `x-auth-token`, `x-amz-security-token`, `x-csrf-token`, plus any
  name matching `auth`, `api.?key`, `secret`, `token` or `cookie`
  (case-insensitive).
- Multi-value headers are joined with `", "`.
- Each blob is capped at 8 KB; when it is larger, headers are dropped
  longest-value-first until it fits.

Turn it off with `captureHeaders: false`:

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  requestLogging: {
    captureHeaders: false,
  },
});
```

`serializeHeaders(headers, { maxBytes, redactor })` is exported for manual capture.

## PII redaction

Header values and JSON request/response body fields are redacted in the
middleware before the record is queued, so raw values never sit in the
in-memory queue. Built-in patterns always apply (same lists as the Python SDK)
and are matched case-insensitively anywhere in the name:

- Query params (`DEFAULT_MASK_QUERY_PARAMS`): `auth`, `api.?key`, `secret`,
  `token`, `password`, `pwd`
- Headers (`DEFAULT_MASK_HEADER_PATTERNS`): `auth`, `api.?key`, `secret`,
  `token`, `cookie`
- JSON body fields, at any depth (`DEFAULT_MASK_BODY_FIELDS`): `password`,
  `pwd`, `token`, `secret`, `auth`, `card.?number`, `ccv`, `cvv`, `cvc`, `ssn`

Your own regexes extend the built-ins, never replace them. Anchor them for an
exact match:

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  redactQueryParams: ["^session$"],
  redactHeaders: ["^x-tenant$"],
  redactBodyFields: [/^iban$/, "^dob$"],
});
```

Matching values become `[redacted]`; names stay visible. In bodies, string,
number, object and array values are masked (a matching object is masked
whole); booleans and `null` stay. Non-JSON bodies are sent unchanged. An
invalid regex throws when the middleware is created. Query-param patterns
apply to the query string sent on `raw_path`. `Redactor` (with
`redactQuery`, `redactBody` and `headerMatches`) is exported for manual capture.

### Body mask callbacks

For non-JSON bodies or per-route rules, pass `maskRequestBody` /
`maskResponseBody`. Each gets an info object and the captured (truncated) body
as a `Buffer`, and returns the body to keep:

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  maskRequestBody: (info, body) => (info.path.startsWith("/kyc") ? null : body),
  maskResponseBody: (info, body) =>
    info.statusCode >= 400 ? body : Buffer.from(body.toString().replace(/\d{4,}/g, "####")),
});
```

- The callback runs first; the regex field masking (built-ins plus your
  patterns) still runs on whatever it returns, so it cannot switch the
  built-ins off.
- Returning `null` stores the whole body as `[masked]`. Fail closed: a throw,
  or a return that is not a `Buffer`/string (a `Promise` included), also
  stores `[masked]`.
- Request info: `method`, `path`, `rawPath` (query already redacted),
  `headers` (lower-cased, unredacted), `contentType`. Response info:
  `request`, `statusCode`, `headers`, `contentType`.

### Content types

Only JSON (`application/json`, `application/*+json`), `text/*` and
form-encoded bodies are captured (`DEFAULT_CAPTURE_CONTENT_TYPES`); form bodies
are masked field by field like a query string. Any other body (multipart
uploads, images, octet streams, no Content-Type) is never buffered and is sent
as `[<content-type>, N bytes omitted]`; the mask callbacks do not run for it.
`captureContentTypes: ["application/json", "application/xml"]` replaces the
list (globs, case-insensitive, parameters ignored).

## Path templating

Requests are grouped by route template, so `/product/123` and `/product/324`
are one endpoint, `GET /product/{id}`. Every record also carries `raw_path`,
the exact path as received plus the query string (matching query-param values
redacted, e.g. `/product/123?token=[redacted]&page=2`).

- **Matched Express route (preferred):** `req.baseUrl + req.route.path`, with
  `:name` parameters spelled `{name}`. Mounted routers work:
  `app.use("/api/users", users)` + `users.get("/:userId")` gives
  `/api/users/{userId}`. Express reports a mount path such as
  `/teams/:teamId` already filled in (`/teams/42`), so its id-looking segments
  go through the heuristic below (`/teams/{id}/members/{memberId}`).
- **Heuristic fallback** (404s, static files, RegExp routes): integer and ULID
  segments become `{id}`, UUIDs `{uuid}`, hex of 24+ chars `{hash}`, and mixed
  alphanumeric tokens of 16+ chars with a digit `{id}`.

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  parametrizePaths: false, // keep raw paths when no route matched (default true)
});
```

`APILENS_PARAMETRIZE_PATHS=false` turns the heuristic off regardless of code.
Matched route templates are always used.

## Exclusions

Excluded requests bypass capture entirely: nothing is buffered and no record
is sent. Health checks and probes are excluded by default (same list as the
Python SDK); all patterns are case-insensitive regexes, searched against the
request path without the query string.

Default paths (`DEFAULT_EXCLUDED_PATHS`):

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

Default user agents (`DEFAULT_EXCLUDED_USER_AGENTS`):

```
health[-_ ]?check
microsoft-azure-application-lb
googlehc
kube-probe
```

Add your own, or turn the defaults off:

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  excludePaths: ["^/internal/", /^\/status$/],
  excludeUserAgents: ["uptimerobot"],
  defaultExclusions: true, // false records health checks again
});
```

`APILENS_EXCLUDE_PATHS` (comma-separated) adds path patterns on top. An
invalid regex throws when the middleware is created, never per request.

## Sampling

Sampling never changes metrics. A sampled-out request still sends its base
record (method, path, status, latency, sizes, consumer) with `sampled: false`;
only headers and bodies are dropped, and its response body is never buffered.

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  sampleRate: 0.1, // keep detail for 10% of requests (default 1)
  // Runs when the request arrives: true/false is final, a number is a
  // probability, undefined falls back to sampleRate.
  sampleOnRequest: (info) => (info.path.startsWith("/admin") ? true : undefined),
  // Runs after the response; undefined keeps the prior decision. It can
  // drop detail but never resurrect a request sampled out on request.
  sampleOnResponse: (info) => (info.statusCode >= 400 ? true : undefined),
});
```

Keep detail only for errors:

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  sampleOnResponse: (info) => info.statusCode >= 400,
});
```

`sampleOnRequest` gets `{ method, path, query, userAgent, headers, clientIp }`;
`sampleOnResponse` gets `{ method, route, rawPath, statusCode, responseTimeMs,
consumerId, consumerName, consumerGroup, sampled }`. A callback that throws is
logged once and treated as `undefined`. A `sampleRate` outside `[0, 1]` throws
when the middleware is created.

## Capture profiles

`captureProfile` picks a capture posture in one greppable setting. It only
fills the `requestLogging` flags you did not set, so an individual flag (in
code or from an `APILENS_*` variable) always wins over the preset.

| Profile | Headers | Bodies | Body cap | Use it for |
|---|---|---|---|---|
| `metadata` | off | off | — | First production rollout: method, path, status, latency, sizes and consumer only. |
| `redacted` | on (sensitive values `[redacted]`) | on (built-in masking) | 16 KB | Debugging with payloads, masked. |
| `full` | on | on | `maxPayloadBytes` (8 KB) | Same as leaving it unset (the current defaults). |

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  captureProfile: "metadata",
  // Individual flags win over the preset: request bodies only.
  requestLogging: { logRequestBody: true },
});
```

The built-in masking (`DEFAULT_MASK_*`, sensitive headers) applies under every
profile. Under `metadata`, `requestLogging.capturePayloads: true` asks for both
bodies. `APILENS_CAPTURE_PROFILE=metadata` sets the preset without a code
change; a `captureProfile` in code wins over it. An unknown profile throws when
the middleware is created.

## Environment variables

Every option below can be set from the environment, on both the client and the
Express middleware, so a rollout or a kill switch needs no code change. The
names and value syntax are the same as the Python SDK. Precedence:
**explicit option > env var > default** (and the capture profile only fills
flags still unset after that).

Booleans accept `1`/`0`/`true`/`false` (also `yes`/`no`/`on`/`off`, any case).
Lists are comma-separated (`APILENS_REDACT_BODY_FIELDS=^password$,^ssn$`); a
regex that needs a literal comma must be passed as an array in code. Unset or
empty variables are ignored; an unparseable value throws an `Error` naming the
variable when the client or middleware is created. `loadEnvConfig()` returns
the parsed values and `resolveConfig(config)` the effective config.

| Variable | Option | Type | Default |
|---|---|---|---|
| `APILENS_API_KEY` | `apiKey` | string | — (required) |
| `APILENS_APP_ID` | `appId` | string | `""` |
| `APILENS_ENVIRONMENT` | `environment` | string | `"production"` |
| `APILENS_BASE_URL` | `baseUrl` | string | `https://ingest.apilens.ai/v1` |
| `APILENS_ENABLED` | `enabled` | bool | `true` |
| `APILENS_CAPTURE_PROFILE` | `captureProfile` | `metadata` / `redacted` / `full` | unset (= `full`) |
| `APILENS_CAPTURE_HEADERS` | `requestLogging.captureHeaders` | bool | `true` |
| `APILENS_CAPTURE_PAYLOADS` | `requestLogging.capturePayloads` | bool | `true` |
| `APILENS_LOG_REQUEST_BODY` | `requestLogging.logRequestBody` | bool | `true` |
| `APILENS_LOG_RESPONSE_BODY` | `requestLogging.logResponseBody` | bool | `true` |
| `APILENS_MAX_PAYLOAD_BYTES` | `requestLogging.maxPayloadBytes` | int | `8192` |
| `APILENS_CAPTURE_CONTENT_TYPES` | `captureContentTypes` | list | JSON, `+json`, `text/*`, form-encoded |
| `APILENS_REDACT_QUERY_PARAMS` | `redactQueryParams` | list | none (built-ins always apply) |
| `APILENS_REDACT_HEADERS` | `redactHeaders` | list | none (built-ins always apply) |
| `APILENS_REDACT_BODY_FIELDS` | `redactBodyFields` | list | none (built-ins always apply) |
| `APILENS_EXCLUDE_PATHS` | `excludePaths` | list, **added to** the code value | none |
| `APILENS_EXCLUDE_USER_AGENTS` | `excludeUserAgents` | list, **added to** the code value | none |
| `APILENS_DEFAULT_EXCLUSIONS` | `defaultExclusions` | bool | `true` |
| `APILENS_SAMPLE_RATE` | `sampleRate` | number 0–1 | `1` |
| `APILENS_CAPTURE_SPANS` | `captureSpans` | bool, `false` **wins over code** | `true` |
| `APILENS_BATCH_SIZE` | `batchSize` | int | `200` |
| `APILENS_FLUSH_INTERVAL` | `flushIntervalMs` | number, **seconds** | `3` (3000 ms) |

Also read from the environment, with their own rules: `APILENS_RELEASE` /
`APILENS_COMMIT` (release stamping) and `APILENS_PARAMETRIZE_PATHS=false`
(wins over code, see [Path templating](#path-templating)).

## Delivery and health

The client never blocks your request path and never grows without bound:

- `maxQueueSize` (default `10000` records) and `maxQueueBytes` (default 64 MB,
  estimated) cap the in-memory queue. When either is full the oldest records
  are dropped.
- `maxBatchBytes` (default 4 MB) caps one ingest request body. Batches are cut
  at `batchSize` records or `maxBatchBytes`, whichever comes first. A single
  record larger than the limit is truncated (payloads first), not dropped.
  With bodies on, `batchSize: 100` / `maxBatchBytes: 4 * 1024 * 1024` is a
  good starting point.
- `compress` (default `true`) gzips request bodies off the request path.
- 408, 429, 5xx and network errors are retried up to `maxRetries` with
  full-jitter exponential backoff, honouring `Retry-After` (capped at 60 s).
  Other 4xx responses are not retried; a 401 logs one clear message.

`client.stats()` returns a snapshot for dashboards and alerts:

```ts
const client = ApiLensClient.getInstance();
client.stats();
// { queuedRecords, queuedBytes, sentBatches, sentRecords, failedBatches,
//   droppedCount, dropCounts: { queue_full, queue_bytes, non_retryable,
//   retries_exhausted, truncated }, lastError, lastSuccessAt }
```

Pass `onStats` to export them after every flush:

```ts
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "my-app",
  onStats: (s) => {
    gauge("apilens_queued_records", s.queuedRecords);
    counter("apilens_dropped_records", s.droppedCount);
  },
});
```

`truncated` counts records that were shortened and still sent, so it is not
part of `droppedCount`.

## Tracing

Every captured request carries a W3C `trace_id` and `span_id`. An incoming
`traceparent` header is continued; otherwise a new trace starts. On top of the
request record the middleware sends, through the same batching client:

- a `server` span per request to `POST /v1/traces`;
- a child `http` span for every outbound call made while handling it, with
  `http`/`https` (`request`, `get`, so axios and most clients) and
  `fetch`/undici (observed through `diagnostics_channel`). Each call gets a
  `traceparent` header, so an instrumented downstream service joins the same
  trace. Span names carry the URL without query string or credentials;
- one ERROR log to `POST /v1/logs` when the response is a 5xx, with the error
  message and stack when the handler threw (`logger_name`
  `apilens.exception`), else `HTTP 503 on GET /path` (`apilens.http`).

Spans and the error log are request detail: a sampled-out request keeps its
trace ids and still propagates `traceparent`, but sends neither. Calls made
outside a request and the SDK's own uploads are never traced.
`currentTraceId()`, `currentSpanId()` and `currentTraceparent()` return the
current request's ids, e.g. to stamp your own logs.

`captureSpans: false` turns all of it off (no trace ids, spans, propagation or
error log); `APILENS_CAPTURE_SPANS=false` does too, whatever the code says.
`serviceName` sets the spans' `service_name` (default: the app id).

## Heartbeat, metadata and remote capture policy

- **Heartbeat.** The client sends `POST /v1/heartbeat` on start, every
  `heartbeatIntervalMs` (default 60 s, at least 10 s) and once more with
  `final: true` on shutdown, carrying the SDK and Node versions, `pid`,
  uptime, release/commit and the `stats()` snapshot. It powers the app's
  "reporting" status. Heartbeats are never retried and never delay data
  delivery. Turn off with `sendHeartbeat: false` or `APILENS_SEND_HEARTBEAT=false`.
- **Metadata.** Once per process start the middleware sends `POST /v1/metadata`:
  framework and version, Node version, the route templates the Express app
  declares (`/orders/:id` reported as `/orders/{id}`, at most 2000) and the
  effective config (callbacks as booleans, never the API key). Routers
  mounted with `app.use("/prefix", router)` are included on Express 4; Express 5
  does not keep a router's mount path, so only routers mounted at `/` are.
  Turn off with `sendMetadata: false` or `APILENS_SEND_METADATA=false`.
- **Remote capture policy.** Each heartbeat answer carries the app's capture
  policy, set in APILens without a redeploy. It **only narrows** what is
  captured: `enabled: false` stops sending records (heartbeats continue),
  `sample_rate` samples out more requests (base record still sent),
  `capture_headers` / `capture_request_body` / `capture_response_body: false`
  drop that detail and `max_payload_bytes` cuts bodies shorter. A local
  setting that captures less always wins. A failed heartbeat keeps the
  previous policy. Read it with `client.remotePolicy`.

## API

- `useApiLens(app, config)`
- `createApiLensMiddleware(config)`
- `createExpressMiddleware(config)` (alias)
- `instrumentExpress(app, config)` (alias)
- `setConsumer(req, consumer)`
- `trackConsumer(req, consumer)`
- `ApiLensClient`
- `loadEnvConfig(env?)`, `resolveConfig(config, env?)`

## Notes

- Add `express.json()` before the API Lens middleware if you want request payload capture.
- `apiKey` is required; prefer loading from env (`APILENS_API_KEY`).
- `ingestPath` resolution rules:
  - `ingest/requests` -> appended to `baseUrl` path.
  - `/ingest/requests` -> resolved from host root.
  - `https://...` -> used as-is.
- Default batch size: `200`
- Default flush interval: `3000ms`
- Backend max ingest batch: `1000` records per request

## Development

```bash
npm install
npm run check
npm run build
npm run test
```
