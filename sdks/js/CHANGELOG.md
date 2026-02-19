# Changelog

## 0.1.1 - 2026-02-19

- Fixed `ingestPath` URL resolution behavior:
  - relative `ingestPath` values (e.g. `ingest/requests`) now resolve under `baseUrl` path
  - leading-slash `ingestPath` values (e.g. `/ingest/requests`) remain host-root for backward compatibility
  - absolute `ingestPath` URLs are used as-is
- Fixed build packaging so published artifacts are consumable in real apps (CJS + ESM).
- Added/expanded tests for ingest URL resolution and Express integration flows.
