# APILens v2 architecture

APILens is an open-source API observability platform that the community
self-hosts and that also runs as a multi-tenant SaaS. v2 is designed for
performance and horizontal scale, with **only open-source dependencies**.
Decisions and their reasons live in [`docs/adr`](../adr).

## Shape: one binary, many roles

```
SDKs / OpenTelemetry ──HTTPS──► edge: API-key check (cached), validation,
                                 limits, normalisation, route templates
                                    │
                        Sink: direct (M1)  │  Kafka 4 (M3)
                                    ▼
                    writer / processor ─────► ClickHouse (tenant-first, rollups)
                                                  ▲
Next.js web ──► api · query · identity · mcp ─────┘
                   │           │
                   │           └──► SpiceDB ◄── outbox ── Postgres
                   ▼
            River jobs ◄──► AI/ML service (Python): calls the API as the user,
                                                    never touches databases
```

The Go module builds **one binary**. `apilens -target=<role>[,<role>]` picks
what a process runs (Grafana Mimir/Tempo pattern), so self-hosters run
`-target=all` in a single container while the SaaS scales each role on its
own signal (edge on RPS, writers on Kafka lag, query on latency).

| Role | Status | Responsibility |
|---|---|---|
| `edge` | **M1** | v1 JSON ingest + OTLP/HTTP, auth, validation, backpressure |
| `all` | **M1** | every implemented role in one process |
| `migrate` | **M1** | one-shot Postgres + ClickHouse migrations (also `apilens migrate`) |
| `api`, `identity` | M2 | control plane (orgs/teams/projects/keys), OIDC provider, passkeys, TOTP |
| `writer`, `processor`, `query` | M3 | Kafka consumers, endpoint discovery, error grouping, typed query compiler |
| `worker`, `mcp` | M4 | alerts and integrations (River), MCP server |
| `saml` | M5 | isolated SAML ACS |

## Code layout

```
cmd/apilens/            entrypoint (only imports internal/app)
internal/app/           composition root: module registry, role targets, CLI
internal/platform/      infrastructure only (config, server, modules, pg, ch, cache, otel)
internal/ingest/        edge role
internal/pipeline/      rows, batcher, sinks, ClickHouse inserters, event conversions
internal/controlplane/  apikeys, catalog (apps), bootstrap (seed), store (sqlc)
internal/migrations/    embedded goose migrations for Postgres and ClickHouse
internal/gen/pb/        generated protobuf (committed)
proto/                  protobuf contracts (buf)
api/openapi/            committed OpenAPI 3.1 spec of the Huma API
test/e2e/               black-box tests against a running stack
tools/                  dev tool versions (separate go.mod) and the load generator
apps/web, apps/ai, apps/docs, packages/sdk-*, deploy/
```

`depguard` (in `.golangci.yml`) enforces the direction of imports: platform
packages never import feature modules, and only `cmd/` imports `internal/app`.

## Ingest path (M1)

1. **Auth**: `X-API-Key` or `Authorization: Bearer`. Keys are project-scoped,
   stored as SHA-256, and verified from an in-process LRU (positive and
   negative). Revocations reach every process through Valkey pub/sub. Nothing
   on this path calls another service per request.
2. **Decode**: gzip or zstd; size is limited both on the wire and after
   decompression (zip-bomb guard).
3. **Validate and normalise**: the same limits as v1 (payload 64 KiB, log
   message 8 KiB, 64 attributes, W3C hex ids, level names), so existing SDKs
   behave identically.
4. **Sink**: a whole request goes into one batch (never half-written). The
   direct sink group-commits batches to ClickHouse with native columnar
   inserts. When the queue is full, the edge answers `503` + `Retry-After`
   (backpressure instead of unbounded memory).
5. **OTLP**: resource `apilens.app` or `service.name` selects the app; records
   for unknown apps are rejected through OTLP partial success.

## Data model

- **Postgres** (control plane): organizations → projects → apps and
  environments, API keys, and a transactional outbox (relayed to SpiceDB in
  M2).
- **ClickHouse** (telemetry): `api_requests`, `api_logs`, `api_spans`,
  `api_deploys`, plus `api_requests_1m` / `_1h` rollups maintained by
  materialized views. The tenant comes first in every `ORDER BY`, tables use
  daily partitions with part-level TTL, and heavy columns are ZSTD-compressed.

## Delivery

- **CI** (`.github/workflows/ci.yml`): path-filtered jobs (Go, integration,
  proto, codegen drift, web, AI, SDKs, Helm, e2e, security). The single
  `ci-passed` gate is the only required check. Every action is pinned by SHA.
- **Images** (`images.yml`): native amd64 + arm64 builds, pushed by digest to
  GHCR, then SBOM, build provenance attestation and cosign keyless signature.
- **Releases** (`release.yml`): release-please (per-component versions) and
  GoReleaser. Staged; active once v2 merges to `main`.
- **Packaging**: `deploy/compose` (self-host all-in-one, hardened) and
  `deploy/helm/apilens` (one Deployment per role, migrations as a pre-upgrade
  hook, no bundled databases: use the CloudNativePG / Altinity / Valkey
  operators).
