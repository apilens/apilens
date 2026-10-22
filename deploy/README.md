# Deploying APILens

| Path | What it is |
|---|---|
| `docker/Dockerfile` | One image for every role: a static Go binary on distroless, running as non-root |
| `compose/compose.yaml` | Self-hosted all-in-one: Postgres, ClickHouse, Valkey, migrate, apilens, console (v2 dashboard) and web (v1 dashboard) |
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

Published ports: ingest/API on 8080, console on 3100, and the v1 dashboard on 3000 (until cutover). Postgres, ClickHouse and Valkey are reachable only on the compose network.

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

## Kubernetes

See [`helm/apilens/README.md`](helm/apilens/README.md). The chart expects externally operated datastores: CloudNativePG, the Altinity ClickHouse operator and Valkey.

## Security notes

- Terminate TLS in front of ports 8080 and 3000 with Caddy, nginx or a cloud load balancer. APILens itself serves plain HTTP.
- The APILens containers:
  - run as UID 65532 with a read-only root filesystem;
  - drop all Linux capabilities and set `no-new-privileges`;
  - use a distroless base (no shell). The healthcheck is `apilens healthcheck`.
- Valkey requires a password (`VALKEY_PASSWORD`) even on the internal network.
- Keep `.env` out of version control (it is gitignored). Use hex secrets, because the Postgres password is embedded in a URL.
- Images are signed with cosign (keyless) and published with SBOM and provenance attestations. To verify one:

  ```bash
  cosign verify ghcr.io/apilens/apilens@<digest> \
    --certificate-identity-regexp 'https://github.com/apilens/apilens/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```
