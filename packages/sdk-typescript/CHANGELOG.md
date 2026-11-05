# Changelog

## Unreleased

- Records carry `raw_path`: the exact path plus the query string, with
  matching query-param values redacted.
- `path` is the matched route template, read when the response is sent, with
  mounted routers (`req.baseUrl + req.route.path`) and `:name` → `{name}`.
- Unmatched paths are parametrized by the id/uuid/ulid/hash heuristic (same as
  the Python SDK); `parametrizePaths: false` or `APILENS_PARAMETRIZE_PATHS=false`
  turns it off.

## 0.1.1 - 2026-02-19

- Fixed `ingestPath` URL resolution behavior:
  - relative `ingestPath` values (e.g. `ingest/requests`) now resolve under `baseUrl` path
  - leading-slash `ingestPath` values (e.g. `/ingest/requests`) remain host-root for backward compatibility
  - absolute `ingestPath` URLs are used as-is
- Fixed build packaging so published artifacts are consumable in real apps (CJS + ESM).
- Added/expanded tests for ingest URL resolution and Express integration flows.
