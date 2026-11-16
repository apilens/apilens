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
   on this path calls another service per request. Keys of a paused project
   get 403 `project_paused` and keys of a deleted one 403 `project_deleted`
   ([`project-lifecycle.md`](project-lifecycle.md)).
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
(`apps/ui/design/tokens.json` compiled to `bundle.css`). The `query` role
accepts two credentials. The UI sends the signed-in **user session** and names
the project with `?project=<slug>`; the request is let through only when
SpiceDB grants `project.view` on it (404 otherwise, 503 when SpiceDB cannot
answer: fail closed). Scripts and self-hosters can still use a project **read
key** (scope `read`), whose project is the key's; ingest keys (`ingest`) cannot
query and read keys cannot ingest. Either way every query filters on the
resolved project first (`internal/query`), and integration tests prove two
projects sharing a trace id never see each other's data and that a user cannot
read another organization's project.

## Data model

- **Postgres** (control plane): organizations → projects → apps and
  environments, API keys, project roles (`project_members`,
  `projects.default_access`), the audit log, and a transactional outbox
  (relayed to SpiceDB). Projects are soft-deleted and purged after a grace
  period ([`project-lifecycle.md`](project-lifecycle.md)).
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
| payload | `auth_time` | when the user signed in to the session (seconds; unchanged by refreshes); sensitive operations need it within `identity.sensitive_action_max_age` (see identity.md) |

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
- `DELETE /api/v1/users/me/sessions/{id}` (`revoked`),
  `POST /api/v1/users/me/sessions/revoke-others` (`revoked`) and
  `POST /api/v1/auth/logout-all` (`logout_all`) end families of the signed-in
  user and audit `session.revoked`. Every ending pushes the family's
  unexpired access-token `sid`s into the Valkey denylist, so those tokens are
  refused within 5 s (see [`identity.md`](identity.md)).

Raw tokens and their hashes are never logged or written to audit metadata.

## Identity and authorization (M2)

Sign-in flows (email code and magic link, Google/GitHub, passkeys, TOTP, SSO),
access-token claims, sessions, the outbox relay to SpiceDB, the capabilities
vocabulary and the error catalogue are documented in
[`identity.md`](identity.md).

## Audit events (M2)

Security-relevant account, organization and project actions are written to
the Postgres `audit_events` table by `audit.Recorder.Record`
(`internal/identity/audit`): one append-only store (D7 in #753), read as a
project's Access › Activity tab and as the organization's audit log. Each row holds whose account it is about
(`user_id`), who did it (`actor_user_id`, NULL for the system or an anonymous
caller), the event kind, event-specific metadata (never secrets), and the
client IP and user agent. The IP and user agent come from the request
context, captured by `audit.Middleware` from the connection's peer address
and `User-Agent` header; forwarding headers are not trusted. When the caller
runs in a transaction (`audit.WithTx`), the event is written in it, so it
commits or rolls back with the change it describes. Kinds are stable once
shipped; a test checks that this table lists every one.

Organization and project events also carry their scope (`org_id`,
`project_id`), the target acted on (`target_type`, `target_id`,
`target_label`, for example `api_key` / its id / its name) and, for a change,
`changes` as `{"previous": ..., "next": ...}`. The recorder fills
`request_id` from the request context (`audit.Middleware` assigns a fresh id
per request and returns it as the `X-Request-Id` response header; an incoming
one is ignored) and `actor_label` from the actor's name, or email, at the
time. `changes` never holds secrets: `Record` refuses a change whose secret
fields (`client_secret`, `key_hash`, `*_token`, ...) carry a value or that
contains API key material, and `audit.Redact` masks secret fields as
`[redacted]` so a change can still say that a secret changed.

**Scope and access (M4).** An event's scope decides who can read it:

| Scope | Columns | Read through | Who |
|---|---|---|---|
| personal | `org_id` and `project_id` NULL (sign-in, sessions, passkeys, 2FA, profile) | not listed by the API; deleted with the account by the user purge | |
| organization | `org_id` set, `project_id` NULL (org settings, members, invitations, SSO, `project.purged`) | `GET /api/v1/orgs/{slug}/audit-events` | org owners and admins (`organization#manage`) |
| project | `org_id` and `project_id` set (projects, access, keys, apps, environments, privacy, alerts, health checks, lifecycle) | `GET /api/v1/projects/{slug}/audit-events`, and the org log for the projects the caller can view | project admins (`project#view_audit`: project Admin, org owners and admins) |

Both listings filter by `actor`, `action` (exact, or a prefix such as
`api_key.`), `target_type`, `from`/`to` and `q` (target label), newest first
with cursor pagination; `…/audit-events/actions` lists the actions with
display labels for the filter, and `…/audit-events/export` streams the same
filters as CSV (at most 100 000 rows, `X-Truncated: true` beyond; audited as
`audit_log.exported`). The org log never shows another project's events: it
asks SpiceDB which of the organization's projects the caller can `view`
(`internal/controlplane/api/audit_events.go`,
`internal/controlplane/auditlog`).

Events are kept `audit.retention` days (400 by default, at least 30, `0`
keeps them forever) and every listing reports it; the daily River job
`identity.audit_retention` deletes older events in batches of 1 000. When a
user is purged, their personal events go and the org and project events they
appear in are anonymised (see [`identity.md`](identity.md)); a purged
project's events stay ([`project-lifecycle.md`](project-lifecycle.md)).

| Kind | Recorded when |
|---|---|
| `user.created` | an account is created (sign-up, invitation, or an operator's `apilens seed` / `apilens user create`: `method` `operator`) |
| `user.updated` | the user changes their profile or preferences (metadata lists the changed field names, never values) |
| `user.deleted` | the user deletes their account: it is hidden, every session is revoked and the purge is scheduled after a 30-day grace period |
| `user.restored` | the user restores their deleted account inside the grace period with a fresh email code |
| `login.succeeded` | a sign-in completes |
| `login.failed` | a sign-in attempt fails (user is NULL for an unknown email) |
| `login.requested` | a sign-in or sign-up email is requested (`intent`; user is NULL for an unknown email) |
| `session.revoked` | a session is signed out or revoked |
| `session.reuse_detected` | a rotated refresh token is replayed and its family is revoked |
| `email.changed` | the account email changes |
| `passkey.added` | a passkey is registered |
| `passkey.removed` | a passkey is deleted |
| `passkey.renamed` | a passkey is renamed (metadata has the old and new name) |
| `totp.enabled` | TOTP two-factor is turned on |
| `totp.disabled` | TOTP two-factor is turned off |
| `recovery.requested` | account recovery is requested |
| `recovery.confirmed` | account recovery completes |
| `recovery.cancelled` | a pending recovery is cancelled |
| `oauth.linked` | an external OAuth/OIDC identity is linked |
| `oauth.unlinked` | an external OAuth/OIDC identity is unlinked |
| `org.created` | an organization is created |
| `org.updated` | an organization's name, allowed domains or domain join change (metadata lists the `fields`) |
| `org.deleted` | an organization is deleted |
| `member.added` | an operator adds a user to an organization with `apilens seed` or `apilens user create\|promote` (metadata has `role`) |
| `member.role_changed` | an organization member's role changes (metadata has `from` and `to`; ownership transfer records one per member) |
| `member.removed` | a member is removed from an organization, or leaves it (metadata `left`) |
| `member.joined` | a user joins an organization through its verified email domain |
| `invitation.sent` | an organization invitation is sent |
| `invitation.accepted` | an organization invitation is accepted |
| `api_key.created` | a project API key is created (metadata has the project, key id, name, display prefix and scopes; never the key) |
| `api_key.revoked` | a project API key is revoked |
| `api_key.updated` | a project API key's permissions or app scope change (metadata has `can_create_apps` and `app_ids`) |
| `api_key.rotated` | a project API key is rotated: a successor with the same name and permissions replaces it and the old key expires at the end of the overlap window (metadata has the old and new key ids and prefixes, `overlap` and `old_expires_at`; never either key) |
| `sso.updated` | an organization's SSO connection is created or changed (metadata has `created`, `enforce`, `secret_changed` and the changed `fields`; never the secret) |
| `sso.deleted` | an organization's SSO connection is removed |
| `capture_policy.updated` | an app's remote capture policy is saved (metadata has the app, its project and the new values) |
| `app.created` | an app is created: with its project (`created_by` dashboard) or by ingest from the app name an SDK sent (`created_by` sdk, with the key id; no actor) |
| `app.archived` | an app is archived from the Apps page |
| `app.restored` | an archived or deleted app is restored; `by` is `dashboard`, or `sdk` when data naming an archived app un-archived it |
| `app.renamed` | an app's display name changes (the slug never does) |
| `app.merged` | an app is merged into another (metadata has both apps); its slug becomes an alias |
| `app.deleted` | an app is deleted; its slug stays reserved for 30 days |
| `app.acknowledged` | a new app the SDK created is kept from the "New app detected" notice |
| `session.reauthenticated` | the user confirms who they are again without signing out (passkey, authenticator code, email code or SSO with `prompt=login`); metadata has `method` and `session_id`. The session's authentication time moves to now |
| `session.reauth_failed` | a re-authentication attempt fails (metadata has `method` and `reason`) |
| `project.created` | a project is created (changes: `name`, `slug`, `environments`) |
| `project.updated` | a project's settings change (changes: the changed fields, such as `name` or `description`) |
| `environment.added` | an environment is added to a project by hand (target: the environment) |
| `environment.updated` | an environment's settings change (changes: the changed fields) |
| `environment.removed` | an environment is removed from a project |
| `privacy_policy.updated` | a project's or app's privacy policy is saved (changes: the masked `query_params`, `headers` and `body_fields` patterns) |
| `invitation.revoked` | a pending organization invitation is revoked; its link stops working |
| `alert_rule.created` | an alert rule is created (changes: its settings) |
| `alert_rule.updated` | an alert rule is changed (changes: the changed settings) |
| `alert_rule.deleted` | an alert rule is deleted |
| `alert_channel.created` | a notification channel is created (changes: `type` and `name`; never its config, which holds secrets) |
| `alert_channel.updated` | a notification channel is renamed or its config replaced (`config_replaced`; never the config) |
| `alert_channel.deleted` | a notification channel is deleted and removed from the rules that used it |
| `health_check.created` | a health check is created (changes: its URL, environment, expected status and state) |
| `health_check.deleted` | a health check is deleted |
| `app_settings.updated` | an app's settings change (changes: `latency_threshold_ms`) |
| `endpoint_settings.updated` | an endpoint's settings are saved (changes: `expected_status_codes`, `latency_threshold_ms`, `excluded`) |
| `project_member.added` | a direct project role is granted to an organization member (metadata has the project and `role`) |
| `project_member.role_changed` | a direct project role changes (metadata has `from` and `to`) |
| `project_member.removed` | a direct project role is removed (metadata has `role` and `self` when people removed their own grant) |
| `project.access_changed` | a project's default access for organization members changes (metadata has `from`, `to` and `lose_access`, how many people lost access) |
| `audit_log.exported` | an organization's or project's audit events are exported as CSV (metadata has `format`, the `filters`, the `rows` exported and `truncated`) |
| `api_key.expired` | a project API key passed its `expires_at` (written once by the hourly expiry job, with no actor; metadata has the key id, name, prefix, scopes and `expires_at`; never the key). Revoked and rotated keys get none: `api_key.revoked` and `api_key.rotated` already say when they stop working |
| `project.paused` | ingest for a project is paused: the ingest edge answers 403 `project_paused` to its keys (changes: `paused`) |
| `project.resumed` | ingest for a paused project is resumed (changes: `paused`) |
| `project.deleted` | a project is deleted and scheduled for purge (changes: `purge_after`, when the purge job may remove it; the slug stays reserved until then) |
| `project.restored` | a deleted project is restored before its purge; its access, API keys and slug come back as they were |
| `project.slug_changed` | a project's slug is renamed (changes: `slug`); the old slug keeps leading to the project until another project takes it and is reserved for it for 30 days |
| `project.purged` | the purge job removed a deleted project's data (ClickHouse telemetry, Postgres rows, SpiceDB relationships, Valkey keys, export files) after its grace period; org-scoped, the system is the actor; the slug is reserved for 30 days |

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
