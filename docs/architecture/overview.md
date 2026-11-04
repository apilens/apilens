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
| `query` | **M1.5** (slice) | dashboard API over rollups/raw tables, read keys, mandatory tenant predicate; M3 adds the typed query compiler |
| `all` | **M1** | every implemented role in one process |
| `migrate` | **M1** | one-shot Postgres + ClickHouse migrations (also `apilens migrate`) |
| `api`, `identity` | M2 | control plane (orgs/teams/projects/keys), OIDC provider, passkeys, TOTP |
| `writer`, `processor` | M3 | Kafka consumers, endpoint discovery, error grouping |
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
apps/ui, apps/ai, apps/docs, packages/sdk-*, deploy/
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

## Read path and console (M1.5)

`apps/ui` is the v2 web UI, built on the APILens design system
(`apps/ui/design/tokens.json` compiled to `bundle.css`). It is server-rendered: pages call the `query` role from the Next.js server with
a project **read key** (`APILENS_READ_KEY`), so no credential reaches the
browser. Read keys carry scope `read`; ingest keys (`ingest`) cannot query and
read keys cannot ingest. Every query derives the project from the key and
filters on it first (`internal/query`), and an integration test proves two
projects sharing a trace id never see each other's data. User sessions
replace read keys in the UI when identity lands (M2).

## Data model

- **Postgres** (control plane): organizations → projects → apps and
  environments, API keys, and a transactional outbox (relayed to SpiceDB in
  M2).
- **ClickHouse** (telemetry): `api_requests`, `api_logs`, `api_spans`,
  `api_deploys`, plus `api_requests_1m` / `_1h` rollups maintained by
  materialized views. The tenant comes first in every `ORDER BY`, tables use
  daily partitions with part-level TTL, and heavy columns are ZSTD-compressed.

## Identity

### Access tokens (M2)

The identity role signs short-lived access tokens with `token.Issuer.Issue`
(`internal/identity/token`): RS256 JWTs signed by the active signing key
(`internal/identity/keys`). They live `identity.access_token_ttl` (15 minutes
by default), so revoking a session takes effect within one TTL: the next
refresh fails and no new access token is issued. Other roles verify them
against the published JWKS; identity uses `token.Issuer.Verify`.

| Where | Claim | Value |
|---|---|---|
| header | `alg` | always `RS256`; verifiers reject any other algorithm (including `none` and HMAC) |
| header | `kid` | RFC 7638 thumbprint of the signing key; must name a published key (active, or retired within the retirement window) |
| payload | `iss` | `identity.issuer` |
| payload | `sub` | user id (UUID) |
| payload | `aud` | `apilens` |
| payload | `iat` | issue time (seconds) |
| payload | `exp` | `iat` + `identity.access_token_ttl` |
| payload | `sid` | session id (UUID) the token was issued for; authz uses it to tie a request to a revocable session |
| payload | `amr` | how the user authenticated (RFC 8176 style), one or more of `email`, `google`, `github`, `passkey`, `totp`, `sso` |

Tokens carry no email, name or role: authorization looks those up by `sub`.
Verification tolerates 30 s of clock skew on `exp` and `iat`.

### Refresh tokens and sessions (M2)

Every sign-in method ends with `session.Service.Create`
(`internal/identity/session`), which starts a session family and returns
`{access_token, refresh_token, expires_in, user}`; the access token's `sid` is
the session row id. The refresh token is 32 random bytes, base64url-encoded;
only its SHA-256 is stored, and it lives `identity.refresh_token_ttl` (30 days)
with "remember me", `identity.refresh_token_ttl_short` (24 hours) without.

- `POST /api/v1/auth/refresh {refresh_token}` rotates: the presented row is
  revoked (`rotated`), a child row with a new token joins the family, and a
  new access token is issued. The lifetime slides from the refresh.
- Presenting a rotated token again (including two concurrent refreshes of one
  token) is reuse: the whole family is revoked (`reuse_detected`),
  `session.reuse_detected` is audited and the caller gets `invalid_token`.
- An expired or ended session answers `session_expired`; an unknown token
  `invalid_token`.
- `POST /api/v1/auth/logout {refresh_token}` revokes the family (`logout`),
  audits `session.revoked` and always answers 204.

Raw tokens and their hashes are never logged or written to audit metadata.

## Identity and authorization (M2)

Sign-in flows (email code and magic link, Google/GitHub, passkeys, TOTP, SSO),
access-token claims, sessions, the outbox relay to SpiceDB, the capabilities
vocabulary and the error catalogue are documented in
[`identity.md`](identity.md).

## Audit events (M2)

Security-relevant account actions are written to the Postgres `audit_events`
table by `audit.Recorder.Record` (`internal/identity/audit`), for users (and
later admins) to inspect. Each row holds whose account it is about
(`user_id`), who did it (`actor_user_id`, NULL for the system or an anonymous
caller), the event kind, event-specific metadata (never secrets), and the
client IP and user agent. The IP and user agent come from the request
context, captured by `audit.Middleware` from the connection's peer address
and `User-Agent` header; forwarding headers are not trusted. When the caller
runs in a transaction (`audit.WithTx`), the event is written in it, so it
commits or rolls back with the change it describes. Kinds are stable once
shipped; a test checks that this table lists every one.

| Kind | Recorded when |
|---|---|
| `user.created` | an account is created (sign-up or invitation) |
| `login.succeeded` | a sign-in completes |
| `login.failed` | a sign-in attempt fails (user is NULL for an unknown email) |
| `session.revoked` | a session is signed out or revoked |
| `session.reuse_detected` | a rotated refresh token is replayed and its family is revoked |
| `email.changed` | the account email changes |
| `passkey.added` | a passkey is registered |
| `passkey.removed` | a passkey is deleted |
| `totp.enabled` | TOTP two-factor is turned on |
| `totp.disabled` | TOTP two-factor is turned off |
| `recovery.requested` | account recovery is requested |
| `recovery.confirmed` | account recovery completes |
| `recovery.cancelled` | a pending recovery is cancelled |
| `oauth.linked` | an external OAuth/OIDC identity is linked |
| `oauth.unlinked` | an external OAuth/OIDC identity is unlinked |
| `org.created` | an organization is created |
| `member.role_changed` | an organization member's role changes |
| `invitation.sent` | an organization invitation is sent |
| `invitation.accepted` | an organization invitation is accepted |

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
