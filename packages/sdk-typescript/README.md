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

`serializeHeaders(headers, { maxBytes })` is exported for manual capture.

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

## API

- `useApiLens(app, config)`
- `createApiLensMiddleware(config)`
- `createExpressMiddleware(config)` (alias)
- `instrumentExpress(app, config)` (alias)
- `setConsumer(req, consumer)`
- `trackConsumer(req, consumer)`
- `ApiLensClient`

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
