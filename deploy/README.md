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

For a scripted setup, `docker compose run --rm --entrypoint /apilens apilens seed` creates a dev org, project and app and prints one JSON line with an `api_key` (scope `ingest`) and a `read_key` (scope `read`). Point an SDK at `http://<host>:8080/v1`, or an OpenTelemetry exporter at `http://<host>:8080/otlp`, with the `api_key`. Seed also makes `dev@example.com` owner of the org and prints a one-time `magic_link` to sign in as it (see [First sign-in](#first-sign-in)).

### First sign-in

A fresh install has no users and, with the default `log` email provider, sends no mail. Either sign up in the UI and copy the code from `docker compose logs apilens`, or bootstrap the first admin from the CLI, which needs no email at all. Every command prints one JSON line; `seed` and `user create|promote` are safe to re-run.

```bash
alias apilens='docker compose run --rm --entrypoint /apilens apilens'

# Dev: seed the org "dev" with owner dev@example.com, then open the printed magic_link.
apilens seed                      # -user-email=you@example.com to pick the address, -user-email= for none

# Self-host: make yourself owner of an existing organization and sign in.
apilens user create -email=you@example.com -org=acme -role=owner
apilens user magic-link -email=you@example.com

# Change the role of an existing user (default owner; owner, admin, member or viewer).
apilens user promote -email=teammate@example.com -org=acme -role=admin
```

| Command | Does |
|---|---|
| `apilens seed` | creates or reuses the dev org/project/app, issues new keys, makes `dev@example.com` (or `-user-email`) an owner and prints its `magic_link` |
| `apilens seed -with-team` | the same, plus demo members, a restricted project with direct grants, environment settings and API keys in every state (see `CONTRIBUTING.md`); re-running changes none of that data |
| `apilens user create -email -org [-role=member]` | creates the user if no account has the address (its email counts as verified) and adds it to the organization, or changes its role |
| `apilens user promote -email -org [-role=owner]` | the same for an existing user only; the last owner of an organization cannot be demoted |
| `apilens user magic-link -email` | prints a sign-in link for an existing user without sending email |

A magic link opens `APILENS_PUBLIC_URL/verify`, works once and expires after 15 minutes; printing a new one invalidates the previous one. Treat it like a password: it signs in as that user. The organization must already exist (create it in the UI or with `seed`). Membership changes are written to the outbox, so SpiceDB permissions follow, and audited as `member.added` / `member.role_changed` (`user.created` with method `operator`, and `login.requested` with method `cli` for links).

Published ports: the API on 8080 and the dashboard on 3000. Postgres, ClickHouse, Valkey and SpiceDB are reachable only on the compose network.

### Services and URLs

`apilens` runs `-target=all`: every role in one process on port 8080, namely `edge` (ingest: `/v1`, `/otlp`), `query` and `api` (the dashboard API under `/api/v1`) and `identity` (`/api/v1/auth/*`). `web` is the dashboard; it calls `apilens` server-side over the compose network, so browsers only ever talk to port 3000 for the UI.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `APILENS_PUBLIC_URL` | `http://localhost:3000` | `web`, `apilens` | Origin users open the dashboard at. `web` uses it for links, redirects and the session cookie (`Secure` when https); identity uses it for email links and as the default WebAuthn origin |
| `APILENS_PUBLIC_INGEST_URL` | `http://localhost:8080` | `web` | Public URL of port 8080 that SDKs send events to, used in the dashboard's setup snippets |
| `APILENS_IDENTITY__ISSUER` | `http://localhost:8080` | `apilens`, `web` | Token issuer: the public URL of the API (port 8080). `web` sends the Google and GitHub sign-in buttons there (`APILENS_PUBLIC_API_URL`) |
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

### Project access, lifecycle and retention

Limits and windows for project access, API keys, project deletion, the audit log and telemetry retention. The defaults are set in `compose.yaml` and listed in `compose/.env.example`; on Kubernetes set the same variables under `config` in the Helm values (`values.schema.json` checks their ranges).

| Variable | Config key | Default | Meaning |
|---|---|---|---|
| `APILENS_IDENTITY__SENSITIVE_ACTION_MAX_AGE` | `identity.sensitive_action_max_age` | `10m` | How old a sign-in may be for sensitive actions (delete or restore a project, rename its slug, change access, create or rotate an API key). Older sessions get `reauth_required` and sign in again |
| `APILENS_PROJECT__DELETION_GRACE` | `project.deletion_grace` | `168h` (7 days) | How long a deleted project can be restored before the purge job removes its data. `0s` purges at the next run |
| `APILENS_ACCESS__MAX_DIRECT_MEMBERS_PER_PROJECT` | `access.max_direct_members_per_project` | `500` | People who can be added to one project directly (`member_limit_reached`). `0` = no limit |
| `APILENS_INGEST__MAX_KEYS_PER_PROJECT` | `ingest.max_keys_per_project` | `50` | Active API keys per project (`key_limit_reached`). `0` = no limit |
| `APILENS_INGEST__RECORD_KEY_IP` | `ingest.record_key_ip` | `true` | Record the client IP of each API key's last ingest request (personal data, for access reviews). `false` stops recording and clears it on next use |
| `APILENS_AUDIT__RETENTION` | `audit.retention` | `400` | Days audit events are kept. At least `30`, or `0` to keep them forever |
| `APILENS_RETENTION__REQUESTS` | `retention.requests` | `90` | Days requests are kept (1 to 3650) |
| `APILENS_RETENTION__LOGS` | `retention.logs` | `30` | Days logs are kept (1 to 3650) |
| `APILENS_RETENTION__SPANS` | `retention.spans` | `30` | Days spans are kept (1 to 3650) |
| `APILENS_RETENTION__ROLLUPS_1M` | `retention.rollups_1m` | `30` | Days per-minute rollups are kept (1 to 400) |
| `APILENS_RETENTION__ROLLUPS_1H` | `retention.rollups_1h` | `400` | Days per-hour rollups are kept (30 to 3650) |

A value out of range stops APILens at start-up with a message naming the key. Retention is per install: every project shares it. `migrate` applies the `retention.*` periods to the ClickHouse table TTLs. Shortening one deletes the older data, so `migrate` refuses until you run it once with `-confirm-retention-change` (`docker compose run --rm migrate migrate -confirm-retention-change`).

### Token signing keys

The identity role signs session tokens (RS256, 2048-bit RSA). On first start it creates a signing key if none is active. Private keys are stored in Postgres, encrypted under `APILENS_IDENTITY__KEY_ENCRYPTION_KEY`.

To rotate the key, for example on a schedule or after an operator leaves:

```bash
docker compose run --rm --entrypoint /apilens apilens identity rotate-key
# Kubernetes: kubectl exec deploy/<deployment running identity or all> -- /apilens identity rotate-key
```

The command prints `{"kid":"<new>","retired_kid":"<previous>"}`. The new key starts signing immediately, and running identity replicas switch to it within 60 seconds. The previous key is retired: it no longer signs, but stays in the published JWKS for `identity.refresh_token_ttl` (30 days by default), so tokens it already signed keep verifying until they expire. Rotation is safe to run while the stack is serving traffic. It needs the same Postgres and key-encryption-key settings as the `identity` role.

### Authorization drift

Postgres is the source of truth for who can see what; SpiceDB holds the derived relationships. The `identity` role relays every change within seconds and, once an hour, reconciles the two: it restores relationships SpiceDB lost and removes ones Postgres has no source for. `apilens_authz_drift_total{kind}` counts what it repaired, so a non-zero rate means something edited SpiceDB behind APILens' back. To reconcile at once, for example after restoring a backup of either store:

```bash
docker compose run --rm --entrypoint /apilens apilens authz reconcile            # add -dry-run to only report
# Kubernetes: kubectl exec deploy/<deployment running identity or all> -- /apilens authz reconcile
```

It prints `{"missing":<n>,"extra":<n>,"dry_run":false}` and needs the same Postgres, SpiceDB and Valkey settings as the `identity` role.

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

Social sign-in needs Valkey: `GET /api/v1/auth/oauth/{provider}/start` keeps each attempt (state, PKCE verifier, nonce) there for 10 minutes so the callback can land on any replica, and is rate-limited per IP (`APILENS_IDENTITY__RATE_LIMITS__OAUTH_START_PER_IP__*`, 30 per 15 minutes by default). The compose stack bundles Valkey.

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
