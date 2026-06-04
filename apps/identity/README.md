# Identity (IAM) service — `apps/identity`

The APILens **identity provider**. Owns authentication and token issuance for the
whole platform and serves the dedicated host **`auth.apilens.ai`**.

## What it does

- Login & sign-up: passwordless **magic-link**, **passkey / WebAuthn**, password
- **TOTP 2-factor** + backup codes + account recovery
- **JWT issuance** — RS256 access tokens + DB-backed rotating refresh tokens
- **JWKS** (`/.well-known/jwks.json`) and **OIDC discovery**
  (`/.well-known/openid-configuration`) so other services verify tokens without
  a shared secret
- **API-key introspection** (`POST /v1/introspect`, internal-only) — the ingest
  service calls this instead of querying the key table directly
- Liveness/readiness probes (`/v1/livez`, `/v1/readyz`); RFC 9457
  `application/problem+json` errors

## Why this is a thin folder (and not its own codebase)

`User` is Django's `AUTH_USER_MODEL` and `Project.owner` is a foreign key to it,
so identity and the core API **share the same `User` data in Postgres**. Forking
a separate auth codebase would duplicate the User model and every battle-tested
auth flow (magic-link, passkey, TOTP, recovery) and invite drift.

So identity is a **deployment role of the shared backend**: the source lives in
`apps/api` (`apps/auth/*`, `routers/auth/*`, `core/auth/*`, `config/urls_identity.py`),
and this folder is just the service's image definition. The `Dockerfile` builds
`FROM` the backend image and flips `ROOT_URLCONF=config.urls_identity`, which
bounds the exposed surface to auth-only. One source of truth, zero duplication,
but still a first-class service: its own image (`${REGISTRY_BASE}/identity`), its
own container, its own host, and its own OpenAPI.

```
apps/api        # shared Django backend  -> core API (config.urls)        -> api.apilens.ai
apps/identity   # FROM backend + urlconf -> identity   (config.urls_identity) -> auth.apilens.ai
apps/ingest     # standalone FastAPI     -> telemetry ingest               -> ingest.apilens.ai
apps/web        # Next.js BFF                                               -> app.apilens.ai
```

## Build

CI builds this image right after the backend image and passes the backend image
ref as a build-arg:

```bash
docker build \
  --build-arg BACKEND_IMAGE=<registry>/backend:<tag> \
  -t <registry>/identity:<tag> \
  apps/identity
```

`docker-compose.prod.yml` runs it as the `identity` service on the internal
network; Caddy reverse-proxies `auth.apilens.ai` (and the legacy
`api.apilens.ai/api/v1/auth/*` alias) to `identity:8000`.

## Endpoints (served under `/v1`, OIDC docs at the root)

| Path | Purpose |
|------|---------|
| `/.well-known/openid-configuration` | OIDC discovery |
| `/.well-known/jwks.json` | Public signing keys (RS256) |
| `/v1/magic-link`, `/v1/verify`, `/v1/refresh`, `/v1/logout` | Auth flows |
| `/v1/passkey/*`, `/v1/2fa/*` | WebAuthn + TOTP |
| `/v1/introspect` | API-key introspection (internal, shared-secret) |
| `/v1/livez`, `/v1/readyz` | Health probes |
| `/v1/docs`, `/v1/openapi.json` | Bounded auth-only API docs |
