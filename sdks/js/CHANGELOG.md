# Changelog

## 0.1.2 - 2026-02-26

- Added Next.js App Router support via `apilens-js-sdk/next`:
  - `withApiLens` route-handler wrapper
  - route wrapper aliases (`createApiLensRouteHandler`, `createNextRouteHandler`, `instrumentNextRouteHandler`)
  - consumer helpers (`setConsumer`, `trackConsumer`)
- Added Next.js config helpers:
  - `createApiLensNextConfig(overrides?)`
  - `getApiLensNextEnvSummary(overrides?)`
- Next.js wrapper now supports zero-config env loading from:
  - `APILENS_API_KEY`
  - `APILENS_BASE_URL`
  - `APILENS_ENVIRONMENT`
- When API key is missing, Next.js wrapper now auto-disables instrumentation instead of throwing.
- Added tests for Next.js route captures, OPTIONS skipping, and error-path logging.
- Added tests for env-based config resolution, explicit override precedence, payload truncation, and fallback `getConsumer` behavior.
- Updated package exports/build config for the new `./next` subpath.

## 0.1.1 - 2026-02-19

- Fixed `ingestPath` URL resolution behavior:
  - relative `ingestPath` values (e.g. `ingest/requests`) now resolve under `baseUrl` path
  - leading-slash `ingestPath` values (e.g. `/ingest/requests`) remain host-root for backward compatibility
  - absolute `ingestPath` URLs are used as-is
- Fixed build packaging so published artifacts are consumable in real apps (CJS + ESM).
- Added/expanded tests for ingest URL resolution and Express integration flows.
