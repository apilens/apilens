# Deploying APILens

| Path | What it is |
|---|---|
| `docker/Dockerfile` | One image for every role: a static Go binary on distroless, running as non-root |
| `compose/compose.yaml` | Self-hosted all-in-one: Postgres, ClickHouse, Valkey, SpiceDB, migrate, apilens, console (v2 dashboard) and web (v1 dashboard) |
| `compose/compose.dev.yaml` | Datastores only, for local development (ports bound to 127.0.0.1) |
| `compose/compose.ci.yaml` + `compose/ci.env` | Override with throwaway secrets for CI end-to-end tests |
| `helm/apilens/` | Kubernetes chart: one Deployment per role, migrations as a hook Job |

## Self-host quickstart (Docker Compose)

```bash
cd deploy/compose
cp .env.example .env          # set every secret: openssl rand -hex 32
docker compose up -d --wait   # add --build to build the images from source
docker compose run --rm --entrypoint /apilens apilens seed
```

`seed` prints one JSON line with two keys:
- `api_key` (scope `ingest`): point an SDK at `http://<host>:8080/v1`, or an OpenTelemetry exporter at `http://<host>:8080/otlp`, with this key.
- `read_key` (scope `read`): put it in `.env` as `APILENS_READ_KEY`, then `docker compose up -d console`. The v2 dashboard runs on port 3100 (`APILENS_CONSOLE_PORT`). It calls the API from its server, so the key never reaches browsers.

Published ports: ingest/API on 8080, console on 3100, and the v1 dashboard on 3000 (until cutover). Postgres, ClickHouse, Valkey and SpiceDB are reachable only on the compose network.

### Email

APILens sends sign-in codes, invitations and security alerts by email. Configure it with `APILENS_EMAIL__*` in `.env` (maps to `email.*` in the config file):

| Variable | Default | Meaning |
|---|---|---|
| `APILENS_EMAIL__PROVIDER` | `log` | `smtp` delivers mail; `log` writes each rendered message to the apilens log and sends nothing |
| `APILENS_EMAIL__HOST` | | SMTP relay host. Required for `smtp` |
| `APILENS_EMAIL__PORT` | `587` | SMTP port |
| `APILENS_EMAIL__USERNAME` / `APILENS_EMAIL__PASSWORD` | | SMTP credentials. Leave both empty for an unauthenticated relay |
| `APILENS_EMAIL__FROM` | | Sender, e.g. `APILens <no-reply@example.com>`. Required for `smtp` |
| `APILENS_EMAIL__REPLY_TO` | | Optional Reply-To address |
| `APILENS_EMAIL__TLS` | `starttls` | `starttls` (587), `tls` (implicit, 465) or `none` (local relays only) |
| `APILENS_EMAIL__TIMEOUT` | `10s` | Connect and send timeout |

With the default `log` provider, the `all`, `api` and `identity` roles log a warning at startup. Users cannot receive sign-in codes until you switch to `smtp`. Read the codes from `docker compose logs apilens` while testing.

### Upgrading

```bash
docker compose pull      # or: set APILENS_VERSION in .env to a released tag
docker compose up -d --wait
```

`migrate` runs before `apilens` starts on every `up`. Migrations are forward-only and idempotent. To roll back, run the previous image tag, not a down-migration.

### Backups

The compose stack does not back itself up.
- **Postgres:** use pgBackRest or WAL-G against the `postgres-data` volume.
- **ClickHouse:** use `clickhouse-backup` or the native `BACKUP ... TO S3/GCS`.
- **Restores:** test them regularly.

### OAuth sign-in (Google, GitHub)

Email codes and passkeys always work. Google and GitHub sign-in are optional and independent: a provider is enabled when its client ID is set, and APILens refuses to start if the ID is set without the secret (or the other way round). `GET /api/v1/auth/providers` reports what is enabled, and the sign-in page shows only those buttons.

The redirect (callback) URI is derived from `APILENS_IDENTITY__ISSUER`, the public URL of the API:

```
<issuer>/api/v1/auth/oauth/google/callback
<issuer>/api/v1/auth/oauth/github/callback
```

For example, with `APILENS_IDENTITY__ISSUER=https://api.example.com`, register `https://api.example.com/api/v1/auth/oauth/google/callback`. The URI must match exactly: same scheme, host, port and path, with no trailing slash.

**Google**
1. In the Google Cloud console, open *Google Auth Platform* and configure the consent screen (app name, support email, the `openid`, `email` and `profile` scopes).
2. Go to *Clients* > *Create client*, choose *Web application*, and add the redirect URI above under *Authorized redirect URIs*.
3. Copy the client ID and secret into `.env`:

   ```bash
   APILENS_IDENTITY__OAUTH__GOOGLE__CLIENT_ID=1234-abc.apps.googleusercontent.com
   APILENS_IDENTITY__OAUTH__GOOGLE__CLIENT_SECRET=GOCSPX-...
   ```

**GitHub**
1. Go to *Settings* > *Developer settings* > *OAuth Apps* > *New OAuth App* (under an organization's settings to own it there).
2. Set *Homepage URL* to the dashboard URL (`APILENS_PUBLIC_URL`) and *Authorization callback URL* to the redirect URI above.
3. Generate a client secret and copy both values into `.env`:

   ```bash
   APILENS_IDENTITY__OAUTH__GITHUB__CLIENT_ID=Ov23li...
   APILENS_IDENTITY__OAUTH__GITHUB__CLIENT_SECRET=...
   ```

Then `docker compose up -d --wait` to apply. On Kubernetes, pass the same `APILENS_IDENTITY__OAUTH__*` variables, keeping the secrets in a Secret.

## Kubernetes

See [`helm/apilens/README.md`](helm/apilens/README.md). The chart expects externally operated datastores: CloudNativePG, the Altinity ClickHouse operator and Valkey. SpiceDB runs in-chart (`spicedb.enabled`) or externally (`authz.endpoint`).

## Security notes

- Terminate TLS in front of ports 8080 and 3000 with Caddy, nginx or a cloud load balancer. APILens itself serves plain HTTP.
- The APILens containers:
  - run as UID 65532 with a read-only root filesystem;
  - drop all Linux capabilities and set `no-new-privileges`;
  - use a distroless base (no shell). The healthcheck is `apilens healthcheck`.
- Valkey requires a password (`VALKEY_PASSWORD`) even on the internal network.
- SpiceDB requires a preshared key (`SPICEDB_PRESHARED_KEY`). It keeps its data in a separate `spicedb` database on the bundled Postgres (created by the one-shot `spicedb-db` service), so Postgres backups cover it. `migrate` writes the authorization schema on every `up` (`APILENS_AUTHZ__*` configures the client; see `.env.example`).
- Keep `.env` out of version control (it is gitignored). Use hex secrets, because the Postgres password is embedded in a URL.
- `APILENS_IDENTITY__KEY_ENCRYPTION_KEY` (32 bytes, base64: `openssl rand -base64 32`) encrypts token signing keys and TOTP secrets at rest. The `all` and `identity` roles refuse to start without it. Back it up: losing it makes those secrets unreadable.
- Images are signed with cosign (keyless) and published with SBOM and provenance attestations. To verify one:

  ```bash
  cosign verify ghcr.io/apilens/apilens@<digest> \
    --certificate-identity-regexp 'https://github.com/apilens/apilens/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```
