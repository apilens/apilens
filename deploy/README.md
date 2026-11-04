# Deploying APILens

| Path | What it is |
|---|---|
| `docker/Dockerfile` | One image for every role: a static Go binary on distroless, running as non-root |
| `compose/compose.yaml` | Self-hosted all-in-one: Postgres, ClickHouse, Valkey, SpiceDB, migrate, apilens (`-target=all`) and web (the dashboard, `apps/ui`) |
| `compose/compose.dev.yaml` | Datastores only, for local development (ports bound to 127.0.0.1) |
| `compose/compose.ci.yaml` + `compose/ci.env` | Override with throwaway secrets for CI end-to-end tests |
| `helm/apilens/` | Kubernetes chart: one Deployment per role, migrations as a hook Job |

## Self-host quickstart (Docker Compose)

```bash
cd deploy/compose
cp .env.example .env
# Fill in every secret (or edit .env by hand; see the comments in it):
for k in POSTGRES_PASSWORD CLICKHOUSE_PASSWORD VALKEY_PASSWORD SESSION_SECRET SPICEDB_PRESHARED_KEY; do
  sed -i.bak "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env
done
sed -i.bak "s|^APILENS_IDENTITY__KEY_ENCRYPTION_KEY=.*|APILENS_IDENTITY__KEY_ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env && rm .env.bak
docker compose up -d --wait   # add --build to build the images from source
```

Then open http://localhost:3000 and sign up. With the default `log` email provider nothing is sent: the sign-in code is in `docker compose logs apilens` (see [Email](#email) to deliver mail). Onboarding then creates your organization and project.

For a scripted setup, `docker compose run --rm --entrypoint /apilens apilens seed` creates a dev org, project and app and prints one JSON line with an `api_key` (scope `ingest`) and a `read_key` (scope `read`). Point an SDK at `http://<host>:8080/v1`, or an OpenTelemetry exporter at `http://<host>:8080/otlp`, with the `api_key`.

Published ports: the API on 8080 and the dashboard on 3000. Postgres, ClickHouse, Valkey and SpiceDB are reachable only on the compose network.

### Services and URLs

`apilens` runs `-target=all`: every role in one process on port 8080, namely `edge` (ingest: `/v1`, `/otlp`), `query` and `api` (the dashboard API under `/api/v1`) and `identity` (`/api/v1/auth/*`). `web` is the dashboard; it calls `apilens` server-side over the compose network, so browsers only ever talk to port 3000 for the UI.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `APILENS_PUBLIC_URL` | `http://localhost:3000` | `web`, `apilens` | Origin users open the dashboard at. `web` uses it for links, redirects and the session cookie (`Secure` when https); identity uses it for email links and as the default WebAuthn origin |
| `APILENS_PUBLIC_INGEST_URL` | `http://localhost:8080` | `web` | Public URL of port 8080 that SDKs send events to, used in the dashboard's setup snippets |
| `APILENS_IDENTITY__ISSUER` | `http://localhost:8080` | `apilens` | Token issuer: the public URL of the API (port 8080) |
| `APILENS_IDENTITY__WEBAUTHN__RP_ID` | `localhost` | `apilens` | Passkey relying party: the dashboard's registrable domain, no scheme or port |
| `SESSION_SECRET` | (required) | `web` | Encrypts the dashboard session cookie; at least 32 characters. Rotating it signs everyone out |
| `APILENS_IDENTITY__KEY_ENCRYPTION_KEY` | (required) | `apilens` | 32 random bytes, base64. Encrypts token signing keys and TOTP secrets at rest |

`web` reaches the API at `APILENS_API_URL=http://apilens:8080`, fixed in `compose.yaml`. Behind a TLS proxy on your own domains, set at least:

```bash
APILENS_PUBLIC_URL=https://apilens.example.com
APILENS_PUBLIC_INGEST_URL=https://api.apilens.example.com
APILENS_IDENTITY__ISSUER=https://api.apilens.example.com
APILENS_IDENTITY__WEBAUTHN__RP_ID=apilens.example.com
```

All identity, authorization and email settings (`APILENS_IDENTITY__*`, `APILENS_AUTHZ__*`, `APILENS_EMAIL__*`) are listed with comments in `compose/.env.example`.

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

Mail goes out from a background job (`email.send`) run by the `identity` role, never from the request itself. A failed send is retried 5 times with exponential backoff (30s up to 8m), and each failure is logged with its Message-ID but not the body. `apilens_email_sent_total{template,status}` counts attempts (`sent`, `failed`, `rejected`). With `tls: none`, SMTP credentials are only offered over challenge mechanisms (CRAM-MD5, SCRAM), never in clear text.

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

- Terminate TLS in front of ports 8080 and 3000 with Caddy, nginx or a cloud load balancer. APILens itself serves plain HTTP. Use https public URLs so the dashboard session cookie is `Secure`.
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
