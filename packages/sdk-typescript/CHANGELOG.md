# Changelog

## Unreleased

- Koa middleware (`apilens-js-sdk/koa`: `apiLensKoa`, `instrumentKoa`,
  `setConsumer`) with the route template from `@koa/router`'s
  `ctx._matchedRoute` and the `routers` option's routes in the metadata report.
- Hono middleware (`apilens-js-sdk/hono`: `apiLensHono`, `instrumentHono`,
  `setConsumer`) with the route template from `c.req.routePath`, for Node,
  Bun, Deno and edge runtimes. Its entry point imports no `node:` module.
- Runtime feature detection (`src/runtime.ts`): the capture core finds Node
  builtins at runtime (registered by the Node entry points, else
  `process.getBuiltinModule`) and falls back to `CompressionStream`, Web
  Crypto and a synchronous trace context without them.
- `flushMode: "inline"` client option and `client.flushInline()`: no timers;
  records, a due heartbeat and the metadata report are sent per request
  (the Hono adapter's default on an edge runtime, via `waitUntil`).
- `packageVersion()` also finds packages whose `exports` hide `package.json`.

- Fastify plugin (`apilens-js-sdk/fastify`: `apiLensFastify`, `instrumentFastify`,
  `setConsumer`) on `onRequest` / `onSend` / `onError` / `onResponse`, with the
  route template from `request.routeOptions.url` and the app's routes in the
  metadata report.
- NestJS module (`apilens-js-sdk/nestjs`: `ApiLensModule.forRoot()`,
  `ApiLensInterceptor`, `setConsumer`, `APILENS_CLIENT`) that instruments the
  Express or Fastify platform underneath Nest; reported as framework `nestjs`.
- The request capture core (`src/capture.ts`) is shared by all adapters.
- Tracing: W3C `trace_id` / `span_id` on every record (an incoming
  `traceparent` is continued), a `server` span per request and child `http`
  spans for outbound `http`/`https`/`fetch` calls (with `traceparent`
  propagated) sent to `POST /v1/traces`, and an ERROR log with the stack on
  an unhandled error or 5xx sent to `POST /v1/logs`. `captureSpans: false` /
  `APILENS_CAPTURE_SPANS=false` turn it off; `serviceName` names the spans.
- `APILENS_*` env-var config loader (`src/env.ts`, same names and syntax as
  the Python SDK) for the client and the Express middleware; precedence is
  explicit option > env var > default. `loadEnvConfig()` / `resolveConfig()`
  are exported.
- `captureProfile: "metadata" | "redacted" | "full"` (also
  `APILENS_CAPTURE_PROFILE`) presets; individual flags win over the preset.
- `maskRequestBody` / `maskResponseBody` callbacks `(info, body: Buffer) =>
  Buffer | null` run before the regex field masking; `null`, a throw or a
  non-Buffer return store `[masked]`.
- Content-type aware body capture: JSON, `text/*` and form bodies only (form
  bodies masked field by field); multipart and binary bodies are stored as
  `[<content-type>, N bytes omitted]`. `captureContentTypes` overrides the list.
- Records carry `raw_path`: the exact path plus the query string, with
  matching query-param values redacted.
- `path` is the matched route template, read when the response is sent, with
  mounted routers (`req.baseUrl + req.route.path`) and `:name` → `{name}`.
- Unmatched paths are parametrized by the id/uuid/ulid/hash heuristic (same as
  the Python SDK); `parametrizePaths: false` or `APILENS_PARAMETRIZE_PATHS=false`
  turns it off.
- `POST /v1/heartbeat` on start, every 60 s (`heartbeatIntervalMs`) and a
  final one on shutdown, with `stats()`; `sendHeartbeat` /
  `APILENS_SEND_HEARTBEAT` turn it off.
- `POST /v1/metadata` once per process: Express version, Node version, route
  templates and the effective config; `sendMetadata` /
  `APILENS_SEND_METADATA` turn it off.
- The remote capture policy from the heartbeat is applied and can only narrow
  capture (`client.remotePolicy`, `client.isCapturing()`).

## 0.1.1 - 2026-02-19

- Fixed `ingestPath` URL resolution behavior:
  - relative `ingestPath` values (e.g. `ingest/requests`) now resolve under `baseUrl` path
  - leading-slash `ingestPath` values (e.g. `/ingest/requests`) remain host-root for backward compatibility
  - absolute `ingestPath` URLs are used as-is
- Fixed build packaging so published artifacts are consumable in real apps (CJS + ESM).
- Added/expanded tests for ingest URL resolution and Express integration flows.
