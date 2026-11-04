# APILens Helm chart

Deploys the APILens single binary as one Deployment per **role** (`apilens -target=<role>`), plus the Next.js dashboard.

Datastores are **not bundled**. Run Postgres, ClickHouse and Valkey with their own operators or charts, and point this chart at them.

> Status: v2 Milestone 2. Implemented roles: `all`, `edge`, `identity`, `api`. The other roles (`writer`, `processor`, `query`, `saml`, `worker`, `mcp`) arrive in later milestones. Enabling one now fails the render with a clear message.

## Install

1. Create a Secret holding the credentials:

   ```bash
   kubectl create secret generic apilens-creds \
     --from-literal=postgres-url='postgres://apilens:PASS@pg-rw:5432/apilens?sslmode=require' \
     --from-literal=clickhouse-password='...' \
     --from-literal=valkey-password='...' \
     --from-literal=session-secret="$(openssl rand -hex 32)" \
     --from-literal=identity-key-encryption-key="$(openssl rand -base64 32)" \
     --from-literal=smtp-password='...' \
     --from-literal=spicedb-preshared-key="$(openssl rand -hex 32)" \
     --from-literal=spicedb-datastore-uri='postgres://apilens:PASS@pg-rw:5432/spicedb?sslmode=require'
   ```

   The two `spicedb-*` keys are needed only with authorization enabled (`spicedb.enabled` or `authz.endpoint`). `smtp-password` is needed only with `email.provider=smtp`; add `oauth-google-client-secret` / `oauth-github-client-secret` when you enable social sign-in.

   Keep `identity-key-encryption-key` safe: it encrypts token signing keys and TOTP secrets at rest, and losing or changing it makes them unreadable.

2. Install the chart:

   ```bash
   helm install apilens ./deploy/helm/apilens \
     --set secrets.existingSecret=apilens-creds \
     --set externalClickHouse.addr='{clickhouse-apilens:9000}' \
     --set externalValkey.addr='{valkey:6379}'
   ```

3. Sign in: open the dashboard and sign up with your email. With the default `email.provider=log` nothing is sent, and the sign-in code is in the `all` (or `identity`) pod log (`kubectl logs -l app.kubernetes.io/component=all --tail=-1 | grep "email (log provider"`). Onboarding then creates your organization and project. The install NOTES print these steps for your values.

   Or seed a development project and print an ingest key:

   ```bash
   kubectl exec deploy/apilens-all -- /apilens seed
   ```

The chart is published as an OCI artifact once releases are enabled:

```bash
helm install apilens oci://ghcr.io/apilens/charts/apilens --version <x.y.z>
```

## Key values

| Key | Default | Purpose |
|---|---|---|
| `image.repository` / `tag` / `digest` | `ghcr.io/apilens/apilens` / appVersion / — | `digest` takes precedence; pin it in production |
| `roles.<role>.enabled` | `all: true` | One Deployment and Service per enabled role |
| `roles.<role>.replicas` | 1 (`edge`, `identity`, `api`: 2) | Ignored when `autoscaling.enabled` is true |
| `roles.<role>.autoscaling` | disabled | Creates a CPU-based HPA |
| `roles.identity` / `roles.api` | disabled | Split sign-in (`/api/v1/auth/*`, OAuth, email worker) and the control-plane API out of `all`. Disable `all` and enable `edge`, `identity` and `api` together |
| `config` | log, sink settings | Extra `APILENS_*` env vars (`__` = nesting); these override chart-managed keys |
| `externalClickHouse.*` | `clickhouse:9000`, db `apilens` | Native protocol addresses, user, TLS, cluster name |
| `externalValkey.addr` | `[]` (disabled) | API-key cache invalidation; when empty, falls back to TTL |
| `identity.issuer` | from `ingress.ingestHost` | Token `iss` and OAuth callback base: the public URL browsers reach `/api/v1/auth/*` at |
| `identity.publicUiUrl` | `web.publicUrl` / `ingress.webHost` | Dashboard origin for email links and OAuth redirects |
| `identity.cookieDomain` | — (host-only) | Session cookie domain |
| `identity.webauthn.rpId` / `rpName` / `origins` | dashboard host / `APILens` / dashboard origin | WebAuthn relying party (passkeys) |
| `identity.corsOrigins` | `[]` | Browser origins allowed to call `/api/v1/auth/*` cross-origin; the dashboard does not need it |
| `identity.trustedProxies` | `[]` | IPs/CIDRs whose `X-Forwarded-For` the auth rate limits trust; set to your ingress controller's pod CIDR |
| `identity.oauth.google.clientId` / `github.clientId` | — (disabled) | Social sign-in; the secret comes from `oauth-google-client-secret` / `oauth-github-client-secret`. Register `<issuer>/api/v1/auth/oauth/{google,github}/callback` as the redirect URI |
| `email.provider` | `log` | `log` writes sign-in codes and invitations to the pod log; `smtp` delivers them |
| `email.host` / `port` / `username` / `from` / `replyTo` | — / `587` | SMTP relay; `host` and `from` are required for `smtp`. The password comes from `smtp-password` |
| `email.tls` / `email.timeout` | `starttls` / `10s` | `starttls` (587), `tls` (implicit, 465) or `none` (local relays only) |
| `authz.endpoint` | — (disabled) | External SpiceDB gRPC address (`host:port`). Leave empty when `spicedb.enabled` |
| `authz.insecure` / `authz.cacheTTL` | `false` / `5s` | Plaintext gRPC (forced on for the in-chart SpiceDB); permission check cache lifetime |
| `spicedb.enabled` | `false` | Runs SpiceDB in-chart (Deployment + Service, datastore migrations as an init container) on a separate Postgres database |
| `spicedb.image` / `replicas` / `resources` / `extraEnv` | pinned `v1.57.0` digest / 1 | For HA, run the SpiceDB operator and use `authz.endpoint` instead |
| `secrets.existingSecret` | — | Keys: `postgres-url`, `clickhouse-password`, `valkey-password` (optional), `session-secret` (web UI), `identity-key-encryption-key` (32 bytes, base64; required by the `all` and `identity` roles), `smtp-password` (optional), `oauth-google-client-secret` / `oauth-github-client-secret` (when that provider is enabled), `spicedb-preshared-key` (when authz is enabled), `spicedb-datastore-uri` (with `spicedb.enabled`) |
| `secrets.*` (inline) | — | Development only; renders a chart-managed Secret |
| `migrations.enabled` | `true` | `pre-install`/`pre-upgrade` hook Job running `apilens migrate`; with `spicedb.enabled`, a `post-install`/`post-upgrade` Job applies the SpiceDB schema (`apilens migrate -only=authz`) |
| `web.*` | enabled | Web UI (`apps/ui`) |
| `web.apiUrl` | `identity` Service if enabled, else `ingress.ingestRole` Service | `APILENS_API_URL`: backend base URL the UI server calls |
| `web.publicUrl` | from `ingress.webHost` | `APILENS_PUBLIC_URL`: origin users open the dashboard at; set it when not using the chart's ingress |
| `ai.*` | disabled | Python AI/ML service (M4) |
| `ingress.*` | disabled | `ingestHost` routes to the `ingress.ingestRole` Service (and `/api/v1/auth` to the `identity` Service when that role is enabled); `webHost` routes to the dashboard |
| `podDisruptionBudget` | `maxUnavailable: 1` | Created for roles with more than 1 replica, or with an HPA |
| `defaultTopologySpread` | `true` | Best-effort spread of pods across zones and nodes |

`values.schema.json` validates role names and value shapes. Settings without a dedicated value (token TTLs, rate limits) go through `config`, e.g. `APILENS_IDENTITY__ACCESS_TOKEN_TTL: 15m`.

### Splitting roles

```yaml
roles:
  all: { enabled: false }
  edge: { enabled: true }
  identity: { enabled: true }
  api: { enabled: true }
ingress:
  enabled: true
  ingestRole: edge
  ingestHost: api.example.com   # also the identity issuer
  webHost: app.example.com
```

The web UI then calls the `identity` Service, and the ingress sends `/api/v1/auth/*` (including OAuth callbacks) to it. The dashboard read path (`query` role) is not split out by the chart yet and still runs only inside `all`.


## Running the datastores

| Datastore | Recommended |
|---|---|
| Postgres 17 | [CloudNativePG](https://cloudnative-pg.io) with Barman Cloud plugin backups to object storage |
| ClickHouse 26.8 LTS | [Altinity ClickHouse operator](https://github.com/Altinity/clickhouse-operator): ReplicatedMergeTree, ClickHouse Keeper ×3; set `externalClickHouse.cluster` |
| Valkey 9 | the [valkey-io Helm chart](https://github.com/valkey-io/valkey-helm) or a managed Valkey |
| SpiceDB | `spicedb.enabled` for small installs; the [SpiceDB operator](https://github.com/authzed/spicedb-operator) for HA (set `authz.endpoint`) |

SpiceDB stores its data in its own Postgres database (create it, e.g. `CREATE DATABASE spicedb`, and put its URI in `spicedb-datastore-uri`). Enable `track_commit_timestamp` on that Postgres for SpiceDB's Watch API.

Kafka (Strimzi) is used by the `kafka` sink from M3 onwards.

Bitnami charts are **not** recommended: their free catalog was withdrawn in August 2025.

## Security defaults

- Runs as non-root (65532) with a read-only root filesystem, drops all capabilities and uses the `RuntimeDefault` seccomp profile.
- The ServiceAccount token is not mounted.
- The migrate Job reads credentials from a hook copy of the Secret, or from `existingSecret`, because hook Jobs run before regular resources exist.
