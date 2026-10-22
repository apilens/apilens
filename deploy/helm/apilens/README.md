# APILens Helm chart

Deploys the APILens single binary as one Deployment per **role** (`apilens -target=<role>`), plus the Next.js dashboard.

Datastores are **not bundled**. Run Postgres, ClickHouse and Valkey with their own operators or charts, and point this chart at them.

> Status: v2 Milestone 1 skeleton. Implemented roles: `all`, `edge`. The other roles (`writer`, `processor`, `query`, `api`, `identity`, `saml`, `worker`, `mcp`) arrive in later milestones. Enabling one now fails the render with a clear message.

## Install

1. Create a Secret holding the credentials:

   ```bash
   kubectl create secret generic apilens-creds \
     --from-literal=postgres-url='postgres://apilens:PASS@pg-rw:5432/apilens?sslmode=require' \
     --from-literal=clickhouse-password='...' \
     --from-literal=valkey-password='...' \
     --from-literal=session-secret="$(openssl rand -hex 32)"
   ```

2. Install the chart:

   ```bash
   helm install apilens ./deploy/helm/apilens \
     --set secrets.existingSecret=apilens-creds \
     --set externalClickHouse.addr='{clickhouse-apilens:9000}' \
     --set externalValkey.addr='{valkey:6379}'
   ```

3. Seed a development project and print an ingest key:

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
| `roles.<role>.replicas` | 1 (`edge`: 2) | Ignored when `autoscaling.enabled` is true |
| `roles.<role>.autoscaling` | disabled | Creates a CPU-based HPA |
| `config` | log, sink settings | Extra `APILENS_*` env vars (`__` = nesting); these override chart-managed keys |
| `externalClickHouse.*` | `clickhouse:9000`, db `apilens` | Native protocol addresses, user, TLS, cluster name |
| `externalValkey.addr` | `[]` (disabled) | API-key cache invalidation; when empty, falls back to TTL |
| `secrets.existingSecret` | — | Keys: `postgres-url`, `clickhouse-password`, `valkey-password` (optional), `session-secret` |
| `secrets.*` (inline) | — | Development only; renders a chart-managed Secret |
| `migrations.enabled` | `true` | `pre-install`/`pre-upgrade` hook Job running `apilens migrate` |
| `web.*` | enabled | Dashboard; `web.apiUrl` defaults to the `all` role Service |
| `ai.*` | disabled | Python AI/ML service (M4) |
| `ingress.*` | disabled | `ingestHost` routes to the `ingress.ingestRole` Service; `webHost` routes to the dashboard |
| `podDisruptionBudget` | `maxUnavailable: 1` | Created for roles with more than 1 replica, or with an HPA |
| `defaultTopologySpread` | `true` | Best-effort spread of pods across zones and nodes |

`values.schema.json` validates role names and value shapes.

## Running the datastores

| Datastore | Recommended |
|---|---|
| Postgres 17 | [CloudNativePG](https://cloudnative-pg.io) with Barman Cloud plugin backups to object storage |
| ClickHouse 26.8 LTS | [Altinity ClickHouse operator](https://github.com/Altinity/clickhouse-operator): ReplicatedMergeTree, ClickHouse Keeper ×3; set `externalClickHouse.cluster` |
| Valkey 9 | the [valkey-io Helm chart](https://github.com/valkey-io/valkey-helm) or a managed Valkey |

Kafka (Strimzi) is used by the `kafka` sink from M3 onwards.

Bitnami charts are **not** recommended: their free catalog was withdrawn in August 2025.

## Security defaults

- Runs as non-root (65532) with a read-only root filesystem, drops all capabilities and uses the `RuntimeDefault` seccomp profile.
- The ServiceAccount token is not mounted.
- The migrate Job reads credentials from a hook copy of the Secret, or from `existingSecret`, because hook Jobs run before regular resources exist.
