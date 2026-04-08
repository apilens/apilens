# API Lens JavaScript SDK

JavaScript SDK for API Lens with first-class Express and Next.js APIs.

## Install

```bash
npm install apilens-js-sdk
```

For local workspace testing:

```bash
npm install ./sdks/js
```

## Quick start

### Express

```js
import express from "express";
import { useApiLens, setConsumer } from "apilens-js-sdk/express";

const app = express();
app.use(express.json());

useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  baseUrl: "https://api.apilens.ai/api/v1",
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

### Next.js (App Router)

```ts
import { NextResponse } from "next/server";
import { createApiLensNextConfig, setConsumer, withApiLens } from "apilens-js-sdk/next";

const apilens = createApiLensNextConfig({
  // Optional overrides:
  // baseUrl: "http://localhost:8000/api/v1",
  // environment: "local",
});

export const POST = withApiLens(async (request) => {
  setConsumer(request, { id: "user_123", name: "Demo User", group: "starter" });
  const body = await request.json();
  return NextResponse.json({ ok: true, item: body.item }, { status: 201 });
}, apilens);
```

## Manual capture

```js
import { ApiLensClient } from "apilens-js-sdk";

const client = new ApiLensClient({
  apiKey: "your_app_api_key",
  baseUrl: "https://api.apilens.ai/api/v1",
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

## API

### `apilens-js-sdk/express`

- `useApiLens(app, config)`
- `createApiLensMiddleware(config)`
- `createExpressMiddleware(config)` (alias)
- `instrumentExpress(app, config)` (alias)
- `setConsumer(req, consumer)`
- `trackConsumer(req, consumer)`

### `apilens-js-sdk/next`

- `withApiLens(handler, config)`
- `createApiLensNextConfig(overrides?)`
- `getApiLensNextEnvSummary(overrides?)`
- `createApiLensRouteHandler(handler, config)` (alias)
- `createNextRouteHandler(handler, config)` (alias)
- `instrumentNextRouteHandler(handler, config)` (alias)
- `setConsumer(request, consumer)`
- `trackConsumer(request, consumer)`

### Common

- `ApiLensClient`

## Notes

- Add `express.json()` before the API Lens middleware if you want request payload capture.
- Next.js SDK is designed for App Router route handlers (`app/api/**/route.ts`).
- `createApiLensNextConfig()` reads `APILENS_API_KEY`, `APILENS_BASE_URL`, and `APILENS_ENVIRONMENT`.
- If `APILENS_API_KEY` is missing, Next handler instrumentation auto-disables instead of crashing.
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
