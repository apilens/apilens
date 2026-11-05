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
