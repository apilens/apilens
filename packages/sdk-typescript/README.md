# API Lens — JavaScript / TypeScript SDK

[![npm version](https://img.shields.io/npm/v/apilens-js-sdk.svg)](https://www.npmjs.com/package/apilens-js-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Drop-in observability for Node.js and edge HTTP services. Add one middleware
and API Lens captures every request — endpoint, latency, status, payloads —
attributes it to the consumer who made it, and stitches it into a distributed
trace, then streams it to your dashboard from background timers that never
block your request path.

```js
import express from "express";
import { useApiLens } from "apilens-js-sdk/express";

const app = express();
useApiLens(app, { apiKey: "apilens_xxx", appId: "orders-api" });
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
  - [Express](#express) · [Fastify](#fastify) · [NestJS](#nestjs) · [Koa](#koa) · [Hono](#hono-node-bun-deno-cloudflare-workers-vercel-edge)
- [Consumer attribution](#consumer-attribution)
- [Distributed tracing](#distributed-tracing)
- [Configuration reference](#configuration-reference)
- [Manual capture](#manual-capture)
- [Reliability & performance](#reliability--performance)
- [SDK health & stats](#sdk-health--stats)
- [App metadata](#app-metadata)
- [Heartbeat](#heartbeat)
- [Deployment shapes](#deployment-shapes)
- [Security & privacy](#security--privacy)
- [Network requirements](#network-requirements)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Support](#support)

---

## Install

```bash
npm install apilens-js-sdk      # or: pnpm add apilens-js-sdk / yarn add apilens-js-sdk
```

Each framework adapter is its own entry point (`apilens-js-sdk/express`,
`/fastify`, `/nestjs`, `/koa`, `/hono`); the framework itself is an optional
peer dependency, so you only need the one you use. The package ships ESM and
CommonJS builds with TypeScript types.

Requires Node.js 18+ (for the global `fetch`). The Hono entry point also runs
on Bun, Deno, Cloudflare Workers and Vercel Edge. There are no runtime
dependencies.

---

## The values you need

| Value | What it is | Where to find it |
|-------|-----------|------------------|
| `apiKey` | **Project-level** key. One key works for every app in the project — the server derives the project from the key. | Project → API keys, in the [dashboard](https://app.apilens.ai). |
| `appId` | *Optional.* Name of the app (service) you're instrumenting, e.g. `"orders-api"` or `"Orders API"` — the server normalizes it to a slug and creates apps it hasn't seen. Falls back to env `APILENS_APP_ID`, then `OTEL_SERVICE_NAME`; with none set, data goes to the project's default app. | Any name you choose, or the app's page in the dashboard. |

`apiKey` is required: the client throws at startup without it. The app choice
is logged once at info, e.g. `APILens: app "orders-api" (from APILENS_APP_ID)`.
`projectSlug`
is **optional** — you only pass it if you want the SDK to assert the key
belongs to a specific project. `baseUrl` defaults to
`https://ingest.apilens.ai/v1`.

> Keep the API key out of source. Read it from the environment (`APILENS_API_KEY`
> is picked up automatically) or your secrets manager.

---

## Quick start

```js
import express from "express";
import { useApiLens } from "apilens-js-sdk/express";

const app = express();
app.use(express.json()); // before API Lens, if you want request bodies

useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "orders-api",
  captureProfile: "metadata", // metadata | redacted | full
});

app.get("/orders/:id", (req, res) => res.json({ id: req.params.id }));

process.on("SIGTERM", async () => {
  await app.apilensClient?.handleShutdown({ flush: true });
  process.exit(0);
});
```

Deploy, send traffic, and requests appear in the dashboard within a few seconds.
`captureProfile: "metadata"` sends no headers or bodies, the recommended first
production rollout; see [capture profiles](#capture-profiles).
From here you'll typically add [consumer attribution](#consumer-attribution) (who
called each endpoint) and lean on the automatic [distributed tracing](#distributed-tracing).

---

## How it works

```
┌─────────────────────────────────────────┐
│ your process                             │
│                                          │
│  request ─▶ ApiLens middleware ─▶ handler│
│                    │                     │
│            captures a record             │
│                    ▼                     │
│            in-memory queue  ──┐          │
└───────────────────────────────┼─────────┘
                                 │  background timer (unref'd)
                                 ▼  (batch of 200, or every 3s)
                POST /requests  ·  POST /traces  ·  POST /logs
                                 ▼
                        API Lens ingest ─▶ dashboard
```

1. **Capture is synchronous but trivial.** The middleware wraps the request,
   records method, path, status, latency, byte sizes, client IP, user-agent,
   consumer identity, and (optionally) payloads/headers, then hands the finished
   record to an in-memory queue. It does not touch the network on the request path.
2. **Delivery is asynchronous.** A timer drains the queue in batches (default
   200 records, or every 3 seconds, whichever comes first) and POSTs them to the
   ingest endpoint with retries and exponential backoff. The timers are
   `unref()`'d, so they never keep your process alive.
3. **It fails safe.** If the ingest endpoint is unreachable the queue absorbs the
   backlog up to `maxQueueSize` (default 10,000) records and `maxQueueBytes`
   (default 64 MB) and drops the **oldest** records once either is reached — your
   app keeps serving traffic regardless. Nothing the SDK does can throw into
   your handler.
4. **Requests, spans and logs share the pipeline.** Request records go to
   `/requests`; [trace spans](#distributed-tracing) go to `/traces` and the
   automatic error log to `/logs`, on the same batching client.

Call `client.handleShutdown({ flush: true })` on graceful shutdown to send what
is still queued; see [Deployment shapes](#deployment-shapes). On an edge
runtime the Hono adapter delivers per request instead (`flushMode: "inline"`).

---

## Endpoint grouping (path templating)

`GET /product/123` and `GET /product/324` are the **same endpoint**, so the SDK
groups them under the route template `GET /product/{id}` instead of exploding
into one endpoint per id. It does this the accurate way — by reading the
**matched route** from your framework, with `:name` parameters spelled `{name}`:

| Framework | Source of the template |
| --- | --- |
| Express | `req.baseUrl + req.route.path` (mounted routers included) |
| Fastify | `request.routeOptions.url` |
| NestJS | the Express or Fastify route underneath Nest |
| Koa | `@koa/router`'s `ctx._matchedRoute` (prefixes included) |
| Hono | `c.req.routePath` (`:id{[0-9]+}` spelled `{id}`) |

The **exact URL** is preserved separately as `raw_path` — the path as received
plus the query string, with sensitive query values redacted
(`/product/123?token=[redacted]&page=2`) — and shown in the request log, so you
lose nothing.

Express reports a router's mount path such as `/teams/:teamId` already filled in
(`/teams/42`), so its id-looking segments go through the heuristic below
(`/teams/{id}/members/{memberId}`).

When no route matches (a 404, static files, a RegExp route), the SDK falls back
to a conservative heuristic: integer and ULID segments become `{id}`, UUIDs
`{uuid}`, hex strings of 24+ chars `{hash}`, and mixed alphanumeric tokens of
16+ chars with a digit `{id}`. Disable the fallback with
`parametrizePaths: false` on the middleware, or globally (this wins over code):

```bash
export APILENS_PARAMETRIZE_PATHS=false
```

---

## Framework integrations

| Framework | Entry point | Mechanism | Tracing |
|-----------|-------------|-----------|:-------:|
| Express 4 / 5 | `apilens-js-sdk/express` | Middleware | ✅ |
| Fastify 4 / 5 | `apilens-js-sdk/fastify` | Plugin (hooks) | ✅ |
| NestJS 10+ | `apilens-js-sdk/nestjs` | Module + global interceptor | ✅ |
| Koa 2 / 3 | `apilens-js-sdk/koa` | Middleware | ✅ |
| Hono 4 (Node, Bun, Deno, edge) | `apilens-js-sdk/hono` | Middleware | ✅ |

Every adapter takes the same options (see the
[configuration reference](#configuration-reference)) and builds the client for
you; pass `client` to share one you built yourself. Only one `ApiLensClient`
can exist per process, so instrument each app once.

### Express

```js
import express from "express";
import { useApiLens, setConsumer } from "apilens-js-sdk/express";

const app = express();
app.use(express.json());
useApiLens(app, { apiKey: process.env.APILENS_API_KEY, appId: "orders-api" });

app.get("/v1/orders/:id", (req, res) => {
  setConsumer(req, { id: "user_123", name: "Demo User", group: "starter" });
  res.json({ ok: true });
});
```

`useApiLens(app, config)` mounts the middleware and sets `app.apilensClient`.
`createApiLensMiddleware(config)` returns the bare middleware (aliases
`createExpressMiddleware`, `instrumentExpress`). Add `express.json()` before the
API Lens middleware if you want request payload capture. An error a route
passes to `next(err)` is recorded for the 5xx error log and passed on unchanged.

### Fastify

```js
import Fastify from "fastify";
import { apiLensFastify, setConsumer } from "apilens-js-sdk/fastify";

const app = Fastify();
await app.register(apiLensFastify, { apiKey: process.env.APILENS_API_KEY, appId: "orders-api" });

app.get("/v1/orders/:id", async (request) => {
  setConsumer(request, { id: "user_123", group: "starter" });
  return { ok: true };
});
```

Register the plugin at the root, before the routes; it skips encapsulation so
it covers every route. `instrumentFastify(app, config)` does the same without
`register`.

### NestJS

```ts
import { Module } from "@nestjs/common";
import { ApiLensModule } from "apilens-js-sdk/nestjs";

@Module({
  imports: [ApiLensModule.forRoot({ apiKey: process.env.APILENS_API_KEY, appId: "orders-api" })],
})
export class AppModule {}
```

The module instruments the Express or Fastify platform underneath Nest when
the app is created, and binds `ApiLensInterceptor` globally so a handler's
error reaches the 5xx error log. `setConsumer(req, consumer)` from
`apilens-js-sdk/nestjs` works with either platform's request; the client is
injectable as `APILENS_CLIENT`. Metadata reports the framework as `nestjs`.

### Koa

```js
import Koa from "koa";
import Router from "@koa/router";
import { bodyParser } from "@koa/bodyparser";
import { apiLensKoa, setConsumer } from "apilens-js-sdk/koa";

const app = new Koa();
const router = new Router();
app.use(apiLensKoa({ apiKey: process.env.APILENS_API_KEY, appId: "orders-api", routers: [router] }));
app.use(bodyParser());

router.get("/v1/orders/:id", (ctx) => {
  setConsumer(ctx, { id: "user_123", group: "starter" });
  ctx.body = { ok: true };
});
app.use(router.routes());
```

Mount the middleware first. A thrown error is kept for the 5xx error log and
rethrown. `routers` lists the routes in the [metadata report](#app-metadata).
`instrumentKoa(app, config)` mounts it and sets `app.context.apilensClient`.

### Hono (Node, Bun, Deno, Cloudflare Workers, Vercel Edge)

```ts
import { Hono } from "hono";
import { instrumentHono, setConsumer } from "apilens-js-sdk/hono";

const app = new Hono();
instrumentHono(app, { apiKey: "<key>", appId: "orders-api" });

app.get("/v1/orders/:id", (c) => {
  setConsumer(c, { id: "user_123", group: "starter" });
  return c.json({ ok: true });
});

export default app;
```

`instrumentHono(app, config)` is `app.use("*", apiLensHono(config))` plus the
app's routes in the metadata report; call it before the routes. `c.error` goes
in the 5xx error log.

`apilens-js-sdk/hono` imports no `node:` module. Node builtins are used when
the runtime has them (`process.getBuiltinModule`), else Web APIs are:
`CompressionStream` for gzip, Web Crypto for ids, and a synchronous trace
context without `AsyncLocalStorage`. Outbound `http` spans need Node. The
capture core uses `Buffer`, so on Cloudflare Workers enable the
`nodejs_compat` compatibility flag. See [serverless and edge](#serverless) for
its `flushMode`.

---

## Consumer attribution

API Lens **never infers who the caller is.** It does not read your `Authorization`
header, decode JWTs, or inspect sessions. You attach the identity explicitly,
once your own auth has resolved it — so you decide exactly what identity (if any)
leaves your process.

Use `setConsumer(req, consumer)` (alias `trackConsumer`) from the adapter's
entry point, with the framework's request object (`req`, `request`, `ctx` or `c`).

| Field | Type | Notes |
|----------|------|-------|
| `id` (or `identifier`) | `string` | **Required.** Stable id — user id, email, API-key prefix, tenant id. |
| `name` | `string` | Human-readable label shown in the dashboard. |
| `group` | `string` | Team, plan tier, org, or role — used for grouping. |

**Per request, after your auth ran:**

```js
app.use((req, res, next) => {
  if (req.user) {
    setConsumer(req, { id: req.user.id, name: req.user.username, group: req.user.org });
  }
  next();
});
```

**Centralized resolver** — `getConsumer(req, res)` runs when the response is
captured, for requests where `setConsumer` was not called (an explicit
`setConsumer` always wins):

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "orders-api",
  getConsumer: (req) => (req.user ? { id: req.user.email, group: req.user.role } : null),
});
```

You can also pass a plain string (used as the id). Both accept `id`/`identifier`,
`name` and `group` (or `consumer_id`/`consumer_name`/`consumer_group`).

---

## Distributed tracing

Every instrumented request is automatically the root of a trace. With zero extra
code you get:

- a **root span** per request (`kind: "server"`), timed and status-aware, sent to
  `POST /v1/traces`;
- **child spans for outbound HTTP** made with `http`/`https` (`request`, `get`,
  so axios and most clients) and `fetch`/undici (observed through
  `diagnostics_channel`), with the W3C `traceparent` header injected so
  downstream services join the same trace. Span names carry the URL without
  query string or credentials;
- **cross-service stitching** — an inbound `traceparent` is continued, so a call
  chain across several of your services shows up as one waterfall in the dashboard.

Spans are captured **entirely automatically** — there is no manual span API.
Calls made outside a request and the SDK's own uploads are never traced.

### Automatic error capture

When a request **throws an unhandled error** or **returns a 5xx**, APILens
records one ERROR log on that request's trace and marks the span as errored:
the error message and stack when the handler threw (`logger_name`
`apilens.exception`), else `HTTP 503 on GET /path` (`apilens.http`). It shows
up under **Trace messages** in the dashboard, lined up with the span.

Nothing to call — a clean request has no trace messages; a failing one does.
This is the only thing written to `/v1/logs`; it is not a general logging API.

### Propagating the trace

`currentTraceId()`, `currentSpanId()` and `currentTraceparent()` (from
`apilens-js-sdk`) return the active context (empty strings outside a request).
Use `currentTraceparent()` to stamp your own logs or to propagate the trace
across a boundary the SDK doesn't patch (a message queue, a gRPC call).

### Turning tracing on and off

Tracing is on by default (with or without an `appId`). Request analytics keep
working with tracing off — you just stop emitting trace ids, spans, `traceparent`
propagation and the error log.

**Per integration** — pass `captureSpans: false`:

```js
useApiLens(app, { apiKey: process.env.APILENS_API_KEY, appId: "orders-api", captureSpans: false });
```

**Globally, without a code change** — set the environment variable (accepts
`0`/`false`/`no`/`off`). This is a kill-switch: it can only turn tracing **off**,
and it overrides any `captureSpans: true` in code:

```bash
export APILENS_CAPTURE_SPANS=false
```

Spans and the error log are request detail: a [sampled-out](#sampling) request
keeps its trace ids and still propagates `traceparent`, but sends neither.

---

## Configuration reference

Option names are the Python SDK's, camelCased. Durations are in milliseconds
and carry an `Ms` suffix (`flushIntervalMs` for Python's `flush_interval`);
the `APILENS_*` environment variables keep the Python units (seconds). A row
marked **not in the JS SDK** exists in the Python SDK only; the workaround is
given where there is one.

### Client options

Passed to `new ApiLensClient({...})`, or alongside the middleware options to any
adapter (which builds the client for you).

| Option | Default | Description |
|-------|---------|-------------|
| `apiKey` | — (required) | Project-level API key. Also `APILENS_API_KEY`. |
| `projectSlug` | `""` | Optional. If set, the server validates the key belongs to it. |
| `baseUrl` | `https://ingest.apilens.ai/v1` | Ingest endpoint. |
| `environment` | `"production"` | Environment label (e.g. `production`, `staging`, `dev`). |
| `batchSize` | `200` | Records per POST (also the flush trigger). Backend max is 1000. |
| `maxBatchBytes` | `4 * 1024 * 1024` | Byte cap on one POST's JSON body (uncompressed). A batch is cut at `batchSize` records or `maxBatchBytes`, whichever comes first. Minimum 1 KB; keep it under the ingest edge's 16 MB limit. See [batch sizing](#reliability--performance). |
| `flushIntervalMs` | `3000` | Milliseconds between automatic flushes (minimum 50). |
| `flushMode` | `"background"` | `"background"`: timers flush every `flushIntervalMs`. `"inline"`: no timers; `client.flushInline()` sends what is queued, and the Hono adapter calls it at the end of each request. Hono defaults to `"auto"` (inline on an edge runtime). See [serverless](#serverless). |
| `timeoutMs` | `5000` | Per-request HTTP timeout, in milliseconds. |
| `maxQueueSize` | `10_000` | Record cap per queue; oldest records drop once full. |
| `maxQueueBytes` | `64 * 1024 * 1024` | Memory cap shared by the request, span and log queues (estimated bytes); oldest records drop once exceeded. |
| `maxRetries` | `3` | Retry attempts per batch for 408, 429, 5xx and network errors (full-jitter exponential backoff, or the server's `Retry-After`). |
| `compress` | `true` | gzip each batch (level 5, `Content-Encoding: gzip`) off the request path; falls back to plain JSON if compression fails. `false` sends plain JSON. |
| `verifyTls` | — | **Not in the JS SDK**: the runtime's `fetch` always verifies certificates. |
| `caBundlePath` | — | **Not in the JS SDK**: on Node, set `NODE_EXTRA_CA_CERTS=/path/corp-root.pem`. See [network requirements](#network-requirements). |
| `proxyUrl` | — | **Not in the JS SDK**: pass a `fetchImpl` that goes through your proxy. See [network requirements](#network-requirements). |
| `enabled` | `true` | Master switch; `false` disables capture and the timers entirely. |
| `sendMetadata` | `true` | Report framework, versions, route templates and the effective capture config once per process start (`POST /v1/metadata`). Env `APILENS_SEND_METADATA=false` also turns it off. See [App metadata](#app-metadata). |
| `sendHeartbeat` | `true` | Send `POST /v1/heartbeat` on start, every `heartbeatIntervalMs` and on shutdown; its response carries the remote capture policy. Env `APILENS_SEND_HEARTBEAT=false` also turns it off. See [Heartbeat](#heartbeat). |
| `heartbeatIntervalMs` | `60000` | Milliseconds between heartbeats. Minimum 10 000 (ingest answers 429 to faster ones); a lower value throws. |
| `appId` | `APILENS_APP_ID` → `OTEL_SERVICE_NAME` → `""` | App the client sends records and heartbeats for (free-form name). Empty: records go to the project's default app and no heartbeat/metadata is sent. The adapters pass theirs through. |
| `onStats` | `undefined` | `(stats) => void`, called after every flush with a [stats snapshot](#sdk-health--stats), e.g. to export to Prometheus or StatsD. A throw is logged at debug and ignored. |
| `retryBackoffBaseMs` / `retryBackoffMaxMs` | `250` / `5000` | Base and ceiling, in milliseconds, of the exponential retry backoff. |
| `maskLogRecord` | — | **Not in the JS SDK**: the auto error log carries only the error message and stack, with no request data. |
| `release` / `commit` | `""` | Deploy correlation stamped on every record. Empty auto-detects from `APILENS_RELEASE` / `APILENS_COMMIT` (also `GIT_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`, `HEROKU_SLUG_COMMIT`). |
| `userAgent` | `"apilens-js-sdk/<version>"` | `User-Agent` header the SDK sends to ingest. |
| `ingestPath` / `tracesPath` / `logsPath` | `"requests"` / `"traces"` / `"logs"` | Endpoint paths, relative to `baseUrl` (a leading `/` resolves from the host root, a full `https://` URL is used as-is). |
| `metadataPath` / `heartbeatPath` | `"metadata"` / `"heartbeat"` | Metadata and heartbeat endpoint paths, relative to `baseUrl`. |

JS-only client options:

| Option | Default | Description |
|-------|---------|-------------|
| `fetchImpl` | global `fetch` | The `fetch` used for every ingest call (proxies, custom agents, tests). |
| `logger` | `console` | `{ debug, info, warn, error }` the SDK logs to. |
| `client` | — | Middleware option: an `ApiLensClient` you built, used instead of building one. |

### Capture profiles

`captureProfile` picks a whole capture posture in one greppable word. It sets
the *defaults* of the `requestLogging` flags below; any flag you set explicitly
(in code or with its own `APILENS_*` env var) wins over the preset.

| Profile | Headers | Request / response bodies | Validation errors | Body cap |
|---|---|---|---|---|
| `metadata` | off | off | — | — |
| `redacted` | on, sensitive values masked | on, [default masking](#security--privacy) | — | 16 KB |
| `full` (default) | on, sensitive values masked | on, [default masking](#security--privacy) | — | `maxPayloadBytes` (8 KB) |

Validation-error parsing is not in the JS SDK. Under every profile the base
record (method, route, status, latency, sizes, consumer, IP, user agent, trace
id) is sent, so dashboards and metrics stay exact, and the built-in masking
patterns always apply.

**Default posture.** Without a profile the SDK behaves as `full`. For a **first
production rollout we recommend `metadata`**; move to `redacted` once you have
checked what your payloads contain.

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "orders-api",
  captureProfile: "metadata",            // metadata | redacted | full
  requestLogging: { logResponseBody: true }, // an explicit flag wins over the preset
});
```

Env var: `APILENS_CAPTURE_PROFILE=metadata`. Precedence: explicit flag > the
flag's env var > `captureProfile` (code, then env) > default. Under `metadata`,
`requestLogging.capturePayloads: true` asks for both bodies. An unknown profile
name throws at startup.

### Middleware options

Accepted by every adapter (`useApiLens`, `apiLensFastify`, `ApiLensModule.forRoot`,
`apiLensKoa`, `apiLensHono` and their `instrument*` forms), alongside the client
options.

| Option | Default | Description |
|--------|---------|-------------|
| `appId` | client's | Which app the traffic belongs to (optional; see above). |
| `environment` | client's | Override the environment label per app (alias `env`). |
| `enableRequestLogging` | — | **Not in the JS SDK**: use `captureProfile: "metadata"` to keep only the base record. |
| `captureProfile` | unset (= `full`) | `"metadata"`, `"redacted"` or `"full"`; sets the defaults of the capture flags (see [capture profiles](#capture-profiles)). |
| `requestLogging.capturePayloads` | `true` | Capture request/response bodies (size-limited). |
| `requestLogging.captureHeaders` | `true` | Capture request/response headers (sensitive values redacted). |
| `requestLogging.logRequestBody` / `requestLogging.logResponseBody` | `true` | Toggle each body independently. |
| `requestLogging.maxPayloadBytes` | `8192` | Per-body capture cap; set `0` to disable body capture. |
| `captureValidationErrors` | — | **Not in the JS SDK**: validation responses are captured as ordinary bodies. |
| `captureContentTypes` | `DEFAULT_CAPTURE_CONTENT_TYPES` | Media-type globs whose bodies are captured (default `application/json`, `application/*+json`, `text/*`, `application/x-www-form-urlencoded`); replaces the defaults. Other bodies are never buffered and are stored as `[<content-type>, N bytes omitted]`. |
| `captureSpans` | `true` | Emit trace ids, spans and the error log for this app. |
| `serviceName` | `appId` | Service name shown on spans. |
| `getConsumer` | `undefined` | Optional resolver `(req, res) => consumer` (see [consumer attribution](#consumer-attribution)). |
| `maskRequestBody` / `maskResponseBody` | `undefined` | `(info, body: Buffer) => Buffer \| string \| null` callbacks on the captured (truncated) raw body; see [body mask callbacks](#body-mask-callbacks). |
| `flushOnShutdown` | — | **Not in the JS SDK**: call `client.handleShutdown({ flush: true })` from your shutdown handler (see [Deployment shapes](#deployment-shapes)). |
| `shutdownTimeoutMs` | — | **Not in the JS SDK**: bound the `handleShutdown` promise yourself. |
| `excludePaths` | `undefined` | Regexes (strings or `RegExp`) for paths to skip entirely (no record, span or log), e.g. `["^/health$"]`. Matched case-insensitively against the path without query string. `APILENS_EXCLUDE_PATHS` (comma-separated env var) adds to it. An invalid regex throws at startup. |
| `excludeUserAgents` | `undefined` | Regexes for `User-Agent` values to skip entirely, e.g. `["^uptimerobot"]`. Case-insensitive search. `APILENS_EXCLUDE_USER_AGENTS` (comma-separated env var) adds to it. |
| `defaultExclusions` | `true` | Skip the [built-in health/probe exclusions](#default-exclusions) (applied before `excludePaths`). `false` turns them off; your own `excludePaths` / `excludeUserAgents` still apply. |
| `sampleRate` | `1` | Fraction (0–1) of requests whose detail — headers, bodies, spans, auto error log — is kept. See [sampling](#sampling). A value outside the range throws at startup. |
| `sampleOnRequest` | `undefined` | `(info) => boolean \| number \| undefined` evaluated before the handler; overrides `sampleRate` per request. See [sampling](#sampling). |
| `sampleOnResponse` | `undefined` | `(info) => boolean \| number \| undefined` evaluated after the response; can drop a kept request's detail, never un-drop one. See [sampling](#sampling). |
| `routeResolver` | — | **Not in the JS SDK**: the template always comes from the framework route, else the heuristic. |
| `parametrizePaths` | `true` | Heuristic templating fallback (`/orders/123` → `/orders/{id}`) when no framework template is known. `APILENS_PARAMETRIZE_PATHS=false` (env var) disables it. |

Adapter-specific options: `routers` (Koa: `@koa/router` instances whose routes go
in the metadata report), `flushMode: "auto"` and `waitUntil` (Hono, see
[serverless](#serverless)).

### Sampling

Sampling never changes metrics. Every request still sends its base record
(method, path, status, latency, sizes, consumer, IP, user agent, trace id), so
traffic counts, error rates and latency percentiles stay exact. With
`sampleRate: 0.1`, about 90% of requests are sent with `sampled: false` and no
headers, bodies, spans or error log. Their response bodies are never buffered.

`1` (the default) keeps everything, and `0` sends the base record only. A
sampled-out request still continues the caller's `traceparent` and propagates
it downstream, so child services decide independently.

`sampleOnRequest` decides per request, at request start — before the handler
runs. It receives `{ method, path, query, userAgent, headers, clientIp }` (the
query and headers are unredacted since nothing has left the app yet) and returns:

- `true` / `false` — final: keep / drop this request's detail.
- a number — the probability of keeping it (clamped to 0–1).
- `undefined` / `null` — fall back to `sampleRate`.

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "orders-api",
  sampleRate: 0.1,
  sampleOnRequest: (info) => {
    if (info.path.startsWith("/admin")) return true;       // always keep
    if (info.userAgent.startsWith("kube-probe")) return false; // never keep detail
    return undefined;                                        // use sampleRate
  },
});
```

A callback that throws never reaches your handler: it is logged once and
treated as `undefined`.

`sampleOnResponse` runs after the response, once the route, status and
consumer are known. It receives:

| Field | Meaning |
|---|---|
| `route` | Endpoint the request is grouped under (route template, e.g. `/orders/{id}`) |
| `rawPath`, `method` | The exact URL (sensitive query values redacted) and method |
| `statusCode` | Response status |
| `responseTimeMs` | Latency, the same value the request record carries |
| `consumerId`, `consumerName`, `consumerGroup` | The resolved consumer (empty when none) |
| `sampled` | The request-stage decision (`sampleRate` / `sampleOnRequest`) |

It returns the same answers as `sampleOnRequest`; `undefined` keeps the
request-stage decision. It cannot bring back a request that was sampled out at
request stage (its headers and bodies were never captured). Keep the detail of
failed requests only:

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "orders-api",
  sampleOnResponse: (info) => info.statusCode >= 400,
});
```

### Default exclusions

Unless `defaultExclusions: false`, requests matching any of these are skipped
entirely (nothing buffered, no record, span or log), before `excludePaths` is
checked. All patterns are case-insensitive regexes, searched against the path
without the query string; the lists are the Python SDK's.

Paths (`DEFAULT_EXCLUDED_PATHS`):

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

User agents (`DEFAULT_EXCLUDED_USER_AGENTS`):

```
health[-_ ]?check
microsoft-azure-application-lb
googlehc
kube-probe
```

`OPTIONS` requests are never captured.

### Environment variables

Every capture, masking, sampling and exclusion option can be set from the
environment, so a kill switch or a new redaction pattern never needs a code
change. The names and value syntax are the Python SDK's. Precedence:
**explicit option > env var > default** (the capture profile only fills flags
still unset after that).

Booleans accept `1`/`0`/`true`/`false` (also `yes`/`no`/`on`/`off`, any case).
Lists are comma-separated (`APILENS_REDACT_BODY_FIELDS=^password$,^ssn$`); a
regex that needs a literal comma must be passed as an array in code. Unset or
empty variables are ignored; an unparseable value throws an `Error` naming the
variable when the client or middleware is created. `loadEnvConfig()` returns
the parsed values and `resolveConfig(config)` the effective config.

| Variable | Option | Type | Default |
|---|---|---|---|
| `APILENS_API_KEY` | `apiKey` | string | — (required) |
| `APILENS_APP_ID` | `appId` | string | `OTEL_SERVICE_NAME`, else `""` (default app) |
| `APILENS_ENVIRONMENT` | `environment` | string | `"production"` |
| `APILENS_BASE_URL` | `baseUrl` | string | `https://ingest.apilens.ai/v1` |
| `APILENS_ENABLED` | `enabled` | bool | `true` |
| `APILENS_CAPTURE_PROFILE` | `captureProfile` | `metadata`, `redacted` or `full` | unset (= `full`) |
| `APILENS_CAPTURE_HEADERS` | `requestLogging.captureHeaders` | bool | `true` |
| `APILENS_CAPTURE_PAYLOADS` | `requestLogging.capturePayloads` | bool | `true` |
| `APILENS_LOG_REQUEST_BODY` | `requestLogging.logRequestBody` | bool | `true` |
| `APILENS_LOG_RESPONSE_BODY` | `requestLogging.logResponseBody` | bool | `true` |
| `APILENS_MAX_PAYLOAD_BYTES` | `requestLogging.maxPayloadBytes` | int | `8192` |
| `APILENS_CAPTURE_VALIDATION_ERRORS` | — | not read by the JS SDK | — |
| `APILENS_CAPTURE_CONTENT_TYPES` | `captureContentTypes` | list | JSON, `+json`, `text/*`, form-encoded |
| `APILENS_REDACT_QUERY_PARAMS` | `redactQueryParams` | list | none (built-ins always apply) |
| `APILENS_REDACT_HEADERS` | `redactHeaders` | list | none (built-ins always apply) |
| `APILENS_REDACT_BODY_FIELDS` | `redactBodyFields` | list | none (built-ins always apply) |
| `APILENS_EXCLUDE_PATHS` | `excludePaths` | list, **added to** the code value | none |
| `APILENS_EXCLUDE_USER_AGENTS` | `excludeUserAgents` | list, **added to** the code value | none |
| `APILENS_DEFAULT_EXCLUSIONS` | `defaultExclusions` | bool | `true` |
| `APILENS_SAMPLE_RATE` | `sampleRate` | number 0–1 | `1` |
| `APILENS_CAPTURE_IP` | — | not read by the JS SDK (the client IP is always captured) | — |
| `APILENS_ANONYMIZE_IP` | — | not read by the JS SDK | — |
| `APILENS_CAPTURE_SPANS` | `captureSpans` | bool; `false` wins over code | `true` |
| `APILENS_BATCH_SIZE` | `batchSize` | int | `200` |
| `APILENS_FLUSH_INTERVAL` | `flushIntervalMs` | number, **seconds** | `3` (3000 ms) |
| `APILENS_MODE` | — | not read by the JS SDK; set `flushMode` in code | — |

Also read from the environment, with their own rules: `APILENS_RELEASE` /
`APILENS_COMMIT` (release stamping), `APILENS_PARAMETRIZE_PATHS=false` (wins
over code, see [endpoint grouping](#endpoint-grouping-path-templating)),
`APILENS_SEND_HEARTBEAT=false` and `APILENS_SEND_METADATA=false`.

**Local development:** point the SDK at a local ingest with
`APILENS_BASE_URL=http://localhost:<port>/v1` (or the `baseUrl` option).

---

## Manual capture

For non-HTTP workloads (batch jobs, workers, custom protocols) use the client
directly.

```js
import { ApiLensClient } from "apilens-js-sdk";

const client = new ApiLensClient({ apiKey: "apilens_xxx", appId: "orders-api" });

client.capture({
  method: "POST",
  path: "/internal/reconcile",
  status_code: 200,
  response_time_ms: 12.4,
});

await client.handleShutdown({ flush: true });
```

`ApiLensClient` is a per-process singleton: a second `new ApiLensClient()`
throws, and `ApiLensClient.getInstance()` returns the existing one.
`client.droppedCount` reports records shed under backpressure and
`client.dropCounts()` breaks that total down by reason (see
[Reliability & performance](#reliability--performance)). For manual records,
`serializeHeaders(headers, { maxBytes, redactor })` and `Redactor` (with
`redactQuery`, `redactBody` and `headerMatches`) apply the same masking the
middleware does.

---

## Reliability & performance

Sizing the queue and batches for your traffic, the memory math, shutdown,
serverless and proxies are covered end to end in the
[Delivery reference](https://apilens.ai/docs/sdk-reference/delivery).

- **Non-blocking.** Capture only enqueues; all I/O happens from timers off the
  request path. Ingest latency and outages never slow or fail your requests.
- **Bounded memory.** Queued records are capped both by count
  (`maxQueueSize`, 10,000 per queue) and by size (`maxQueueBytes`, 64 MB
  shared by the request, span and log queues). Whichever limit is hit first,
  the oldest records are dropped rather than the queue growing without limit.
  A record's size is estimated as the length of its payload, header, path and
  user-agent strings plus a fixed 512 B overhead.
- **Drop accounting.** `client.droppedCount` is the total; `client.dropCounts()`
  returns it by reason:

  | Reason | Meaning |
  |---|---|
  | `queue_full` | The queue reached `maxQueueSize`; the oldest record was dropped. |
  | `queue_bytes` | Queued bytes would exceed `maxQueueBytes`; the oldest record(s) were dropped. |
  | `non_retryable` | Ingest rejected the batch with a 4xx other than 408/429; it is not retried. |
  | `retries_exhausted` | The batch still failed (network, timeout, 408, 429, 5xx) after `maxRetries`. |
  | `truncated` | Not a drop: one record was larger than `maxBatchBytes` on its own, so its payloads (then headers) were cut before sending. Not counted in `droppedCount`. |
- **Size-bounded batches.** A POST is cut at `batchSize` records or
  `maxBatchBytes` (default 4 MB, measured on the uncompressed JSON), whichever
  comes first, so a backlog of large records goes out as several requests
  instead of one oversized body that ingest would reject whole. A single record
  over the cap is truncated rather than dropped. With body capture on,
  `batchSize: 100` / `maxBatchBytes: 4 * 1024 * 1024` is a good starting point.
- **Resilient delivery.** 408, 429, 5xx, timeouts and network errors retry up to
  `maxRetries` times with full-jitter exponential backoff (a random wait between
  0 and `250 ms × 2^attempt`, capped at 5 s), so many workers do not retry in
  lockstep. A `Retry-After` header takes precedence, capped at 60 s. Any other
  4xx drops the batch immediately and logs the response body at most once per
  status every 5 minutes; a 401 logs a single clear message.
- **Never throws into your app.** All SDK errors are caught and logged to
  `logger` (default `console`).

---

## SDK health & stats

`client.stats()` returns a snapshot of the delivery pipeline. It is cheap, so it
is fine to call from a health or metrics endpoint.

| Field | Meaning |
|---|---|
| `queuedRecords` | Records waiting in the request, span and log queues. |
| `queuedBytes` | Estimated size of those records (bounded by `maxQueueBytes`). |
| `sentBatches` / `sentRecords` | Batches and records ingest accepted (2xx), since start. |
| `failedBatches` | Batches dropped after a non-retryable 4xx or after `maxRetries`. |
| `dropCounts` | Records dropped, by reason (same keys as `client.dropCounts()`). |
| `droppedCount` | Sum of `dropCounts`, excluding `truncated` (those were still sent). |
| `lastError` | The most recent ingest failure; `null` until one happens. |
| `lastSuccessAt` | ISO 8601 time of the last accepted batch, or `null`. |

**Logging.** After every flush the client logs
`API Lens stats: queued=… sent=… failed=… dropped=…` at debug. When records were
dropped since the last report it logs the drop count at info instead, at most
once a minute.

**Exporting.** Pass `onStats` to push each snapshot to your metrics system. It
runs after every flush; keep it quick and non-blocking.

```js
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "orders-api",
  onStats: (s) => {
    queuedGauge.set(s.queuedRecords);
    sentGauge.set(s.sentRecords);
    for (const [reason, count] of Object.entries(s.dropCounts)) droppedGauge.set({ reason }, count);
  },
});
```

The counters are cumulative, so export them as gauges, or as counters by sending
the difference from the previous snapshot.

**Rollout checklist.** After deploying, confirm `lastSuccessAt` advances and
`sentRecords` grows; `failedBatches` or `droppedCount` rising with a non-empty
`lastError` points at the cause (a 401 means a bad key; network errors mean
egress is blocked, see [Network requirements](#network-requirements)).

---

## App metadata

Once per process start, each adapter sends one report to `POST /v1/metadata`.
The dashboard uses it to list endpoints that have had no traffic yet and to
show the SDK config the app actually runs with.

- **When:** about 1 s after the middleware is created (or on the first inline
  flush), so routes registered later are included and startup is never
  blocked. Failures are retried a few times; anything else is logged once and
  dropped. Requests are never affected.
- **Routes:** discovered from the framework, spelled the same way as the
  endpoint grouping above, at most 2000. Express 4 includes routers mounted
  with `app.use("/prefix", router)`; Express 5 does not keep a router's mount
  path, so only routers mounted at `/` are. Koa reports the `routers` you pass.
- **Turn it off:** `sendMetadata: false`, or env `APILENS_SEND_METADATA=false`.

```json
{
  "app_id": "orders-api",
  "environment": "production",
  "framework": "express",
  "framework_version": "5.1.0",
  "node_version": "22.11.0",
  "sdk_version": "0.1.0",
  "routes": [{ "method": "GET", "path": "/orders/{id}" }],
  "config": { "capture_headers": true, "sample_rate": 1, "...": "..." }
}
```

`project_slug` is added when configured. `config` is the effective config:
built-in redaction patterns and exclusions are listed with yours, and callbacks
are reported as booleans only. **Never sent:** the API key (any field naming one
is stripped at any depth before the POST), the `fetchImpl` or the logger.

---

## Heartbeat

Every client sends `POST /v1/heartbeat`: once on start, then every
`heartbeatIntervalMs` (default 60 s), and once more with `"final": true` on
`handleShutdown`. APILens uses it for app status and uptime ("reporting" while
a heartbeat arrived in the last 5 minutes), and answers with the app's remote
capture policy.

- **Which apps:** each adapter registers its `appId` and environment with the
  client (`client.registerApp(appId, environment)` for manual use).
- **Body:** `app_id`, `environment`, `instance_id` (a UUID, new per process
  start), `sdk_name`, `sdk_version`, `runtime`, `pid`, `uptime_s`, `release`,
  `commit`, and `stats` (the [`client.stats()`](#sdk-health--stats) snapshot).
  Never the API key.
- **Policy:** the response's `policy` (set per app in the dashboard) is applied
  to every record from then on, so capture can be turned down without a deploy.
  `client.remotePolicy` returns the policy in force. It can only make capture
  *narrower* than your local config:
  - `enabled: false` stops all records, spans and logs for the app (heartbeats continue);
  - `sample_rate` samples out more requests (base record still sent);
  - `capture_headers` / `capture_request_body` / `capture_response_body`
    `false` turn those off; `true` never turns on what you disabled locally;
  - `max_payload_bytes` lowers your body cap, never raises it.

  A failed heartbeat keeps the previous policy.
- **Failures are silent:** heartbeats are never retried and never delay data
  delivery; `Retry-After` is honoured.
- **Turn it off:** `sendHeartbeat: false`, or env `APILENS_SEND_HEARTBEAT=false`.

---

## Deployment shapes

The SDK delivers from timers, so whatever is still queued when a process exits
is lost unless it is flushed first. The SDK does not install signal handlers of
its own (that would change how your process exits), so flush from yours:

```js
process.on("SIGTERM", async () => {
  await server.close();
  await client.handleShutdown({ flush: true }); // also sends the final heartbeat
  process.exit(0);
});
```

The adapters expose the client as `app.apilensClient` (Express, Koa via
`app.context.apilensClient`), `APILENS_CLIENT` (NestJS, injectable), or
`ApiLensClient.getInstance()` anywhere.

**Multi-process servers (cluster, PM2, multiple containers).** Each process has
its own client and queue and must flush its own on exit. Processes killed with
`SIGKILL` or by the OOM killer lose up to one `flushIntervalMs` (3 s) of data.
In Kubernetes, `terminationGracePeriodSeconds` (default 30 s) must exceed your
app's own shutdown time plus the flush.

<a id="serverless"></a>
**Serverless and edge (Cloudflare Workers, Vercel Edge, AWS Lambda).** The
runtime freezes or kills the process between invocations, so timers may never
run. Use **inline mode**: `flushMode: "inline"` starts no timers, and
`client.flushInline()` sends the queued records, a due heartbeat and the
metadata report.

- The Hono adapter's default, `flushMode: "auto"`, is `"inline"` on an edge
  runtime: each request's records go out at the end of the request through
  `c.executionCtx.waitUntil()` (pass `waitUntil` yourself on runtimes that
  expose it elsewhere, such as `@vercel/functions`). Without a `waitUntil` the
  work finishes before the response is returned. On Node, Bun and Deno it is
  `"background"`.
- With another adapter or no adapter (a plain Lambda handler, a queue consumer,
  a script), set `flushMode: "inline"` and `await client.flushInline()` at the
  end of each invocation. It never throws for delivery failures (they are
  retried, then dropped and counted in `client.stats()`).

Keep `timeoutMs` and `maxRetries` low there so a slow ingest cannot stretch an
invocation.

**Scripts and jobs.** `await client.handleShutdown({ flush: true })` before exit.

---

## Security & privacy

- **No implicit PII.** The SDK never reads auth headers or infers a consumer —
  identity is only what you pass to `setConsumer(...)` or `getConsumer`.
- **Redaction happens before queueing.** Header values, query values and body
  fields are redacted in the middleware before the record is queued, so raw
  values never sit in the in-memory queue.
- **Sensitive headers are redacted** before they leave the process:
  `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `api-key`, `x-auth-token`, `x-amz-security-token`, and `x-csrf-token` are
  replaced with `[redacted]`. Header JSON (lower-cased names, multi-value
  headers joined with `", "`) is capped at 8 KB; when it is larger, headers
  are dropped longest-value-first until it fits.
- **Default masking patterns always apply** (no configuration needed). Each
  regex is matched case-insensitively anywhere in the *name*; matched values
  are stored as `[redacted]`:

  | Applies to | Built-in patterns (`apilens-js-sdk` exports) |
  |---|---|
  | Query params (`DEFAULT_MASK_QUERY_PARAMS`) | `auth`, `api.?key`, `secret`, `token`, `password`, `pwd` |
  | Headers (`DEFAULT_MASK_HEADER_PATTERNS`) | `auth`, `api.?key`, `secret`, `token`, `cookie` |
  | JSON body fields (`DEFAULT_MASK_BODY_FIELDS`) | `password`, `pwd`, `token`, `secret`, `auth`, `card.?number`, `ccv`, `cvv`, `cvc`, `ssn` |

  So `/search?token=abc` is stored as `/search?token=[redacted]`. Body masking
  covers string, number, object and array values at any depth (a matching
  object is masked whole); booleans and `null` stay visible.
  `redactQueryParams`, `redactHeaders` and `redactBodyFields` add your own
  patterns (strings or `RegExp`; anchor them for an exact match) on top — they
  extend the defaults, never replace them. Patterns are compiled once per
  middleware, never per request, and an invalid regex throws at startup.

  ```js
  useApiLens(app, {
    apiKey: process.env.APILENS_API_KEY,
    appId: "orders-api",
    redactQueryParams: ["^session$"],
    redactHeaders: ["^x-tenant$"],
    redactBodyFields: [/^iban$/, "^dob$"],
  });
  ```
- <a id="body-mask-callbacks"></a>**Body mask callbacks** handle what field
  patterns can't (XML, free text, per-route rules). `maskRequestBody(info, body)`
  gets `{ method, path, rawPath, headers, contentType }` (`rawPath` with the
  query already redacted, `headers` lower-cased and unredacted) and
  `maskResponseBody(info, body)` gets `{ request, statusCode, headers,
  contentType }`, plus the captured bytes as a `Buffer`. Return the body to
  store (`Buffer` or string), or `null` to store `[masked]`. Order is fixed:
  callback → your regex field patterns → built-in defaults, so the defaults
  still apply to whatever the callback returns. Fail closed: a throw, or a
  return that is not a `Buffer`/string (a `Promise` included), stores the whole
  body as `[masked]` — never the raw body.

  ```js
  useApiLens(app, {
    apiKey: process.env.APILENS_API_KEY,
    appId: "orders-api",
    maskRequestBody: (info, body) => (info.path.startsWith("/kyc") ? null : body),
    maskResponseBody: (info, body) =>
      info.statusCode >= 400 ? body : Buffer.from(body.toString().replace(/\d{4,}/g, "####")),
  });
  ```
- **Only JSON, text and form-encoded bodies are captured.** Form-encoded bodies
  are masked field by field (`password=x` is stored as `password=[redacted]`).
  Multipart uploads, binary and untyped bodies are never buffered; they are
  stored as `[<content-type>, N bytes omitted]` and the mask callbacks do not
  run for them. Change the list with `captureContentTypes` (globs,
  case-insensitive, parameters ignored).
- **Bodies are size-limited** to `requestLogging.maxPayloadBytes` (8 KB
  default). Disable body capture entirely with `captureProfile: "metadata"`,
  `requestLogging.capturePayloads: false` or `maxPayloadBytes: 0`.
- **TLS always.** The runtime's `fetch` verifies the ingest certificate.

---

## Network requirements

The SDK makes **outbound HTTPS calls only**; it never listens on a port.

| | |
|---|---|
| Egress host | `ingest.apilens.ai` (or the host in your `baseUrl`) |
| Port / protocol | `443/tcp`, HTTPS (TLS 1.2+) |
| Requests | `POST /v1/requests`, `/v1/traces`, `/v1/logs` (gzip JSON batches), `/v1/heartbeat`, `/v1/metadata` |

**Proxy.** The SDK calls the runtime's `fetch`. To go through an egress proxy,
pass a `fetchImpl` that uses one, for example undici's `ProxyAgent`:

```js
import { fetch as undiciFetch, ProxyAgent } from "undici";

const dispatcher = new ProxyAgent("http://proxy.corp:3128");
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "orders-api",
  fetchImpl: (url, init) => undiciFetch(url, { ...init, dispatcher }),
});
```

**Custom CA.** If a TLS-inspecting proxy re-signs traffic with a corporate root,
start Node with `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-root.pem`. Do not
disable certificate verification in production.

An unreachable proxy or a certificate error is treated as a network error: the
batch is retried with backoff, then dropped and counted under
`dropCounts().retries_exhausted`. Like every SDK error, it never throws into
your app.

---

## Troubleshooting

**Nothing appears in the dashboard.**
1. Confirm the `apiKey` is valid and belongs to the expected project.
2. Confirm `appId` matches an app slug in that project.
3. Confirm `baseUrl` is correct (default `https://ingest.apilens.ai/v1`).
4. Check `client.stats()`: `lastError` names the last ingest failure, and
   `sentRecords` should grow. Pass a `logger` (or watch `console`) for SDK logs.
5. Allow a few seconds for the batching interval before data shows up.
6. Make sure the path isn't a [default exclusion](#default-exclusions)
   (`/health`, `/ping`, ...) and the request isn't `OPTIONS`.

**`apiKey is required` at startup.** Pass it, or set `APILENS_API_KEY`.

**`ApiLensClient is already initialized`.** Only one client can exist per
process: instrument each app once, or pass `client: ApiLensClient.getInstance()`.

**`422 Unprocessable Entity` from ingest.** Check the record fields; `appId` itself
is free-form (an unseen name creates the app).

**`401 Unauthorized`.** The API key is missing, revoked, or not project-scoped.

**Request bodies are empty.** Register your body parser (`express.json()`,
`@koa/bodyparser`) and check the content type is in `captureContentTypes` and
no capture profile turned bodies off.

**Spans/traces are empty.** Ensure `APILENS_CAPTURE_SPANS` isn't `false`. Spans are captured automatically for the
request and for outbound `http`/`https`/`fetch` calls made while handling it.

**Data lost on deploys.** Call `client.handleShutdown({ flush: true })` from your
`SIGTERM` handler; see [Deployment shapes](#deployment-shapes).

---

## Development

```bash
pnpm install
pnpm -F apilens-js-sdk check   # tsc --noEmit
pnpm -F apilens-js-sdk test    # vitest
pnpm -F apilens-js-sdk build   # tsup → dist/
```

Tests live in `tests/`, one file per concern: `sanitize`, `redaction`,
`body-masking`, `sampling`, `exclusions`, `routes`, `env`, `client`,
`delivery`, `heartbeat`, `metadata`, `policy`, `release`, `tracing`, and one
`<framework>.e2e` file per adapter (`hono.edge` for the edge runtime).
`tests/contract.ts` checks the heartbeat and metadata bodies against the ingest
OpenAPI document, and `readme.test.ts` checks this README's option tables
against the Python SDK's.

---

## Support

- Documentation — https://apilens.ai/docs
- Email — hello@apilens.ai
- Issues — https://github.com/apilens/apilens/issues

MIT licensed.
