# APILens

Open-source API observability: request analytics, errors, traces and logs for
your APIs, with SDKs for Python, TypeScript and Java and native
OpenTelemetry ingest. MIT licensed, self-hostable, built to scale out.

> **v2 is under construction on the `v2` branch.** Milestone 1 (ingest
> foundation) is done; the dashboard API, identity and AI features follow.
> The previous Django stack is preserved at tag
> [`legacy-v1`](https://github.com/apilens/apilens/tree/legacy-v1).

## Architecture in one picture

```
SDKs / OpenTelemetry ──► edge ──► sink (direct | Kafka) ──► ClickHouse (rollups)
Next.js dashboard ──► api · query · identity · mcp ──► Postgres · SpiceDB · Valkey
AI/ML service (Python) ──► same API, with the user's permissions
```

One Go binary runs any combination of roles (`apilens -target=edge,query`), so a
self-hosted install is a single container while the SaaS scales each role
independently. Read [docs/architecture/overview.md](docs/architecture/overview.md)
and the [decision records](docs/adr/README.md).

| Layer | Technology |
|---|---|
| Backend | Go 1.27 — one binary, role targets, Huma (OpenAPI 3.1), pgx + sqlc, clickhouse-go |
| Data | ClickHouse 26.8 LTS · Postgres 17 · Valkey 9 · SpiceDB (M2) · Kafka 4 (optional, M3) |
| Web | Next.js 16 — `apps/console` (v2 dashboard, Aperture design system), `apps/web` (v1 dashboard, retired at cutover) |
| AI/ML | Python 3.14, FastAPI, Pydantic AI, statsforecast (`apps/ai`, M4) |
| Contracts | protobuf (buf) for internal events, OpenAPI for the API, v1 JSON + OTLP for ingest |
| Delivery | GitHub Actions, multi-arch images on GHCR (SBOM, provenance, cosign), docker compose, Helm |

## Status

| Milestone | Scope | State |
|---|---|---|
| M1 | Monorepo foundation, edge (v1 JSON + OTLP), ClickHouse schema + rollups, CI, images, compose, Helm skeleton | ✅ done |
| M1.5 | First read path: `query` role (read keys, tenant-scoped dashboard API) and the `apps/console` skeleton | ✅ done |
| M2 | Identity (OIDC, passkeys, TOTP), orgs/teams/projects API, SpiceDB, staging | next |
| M3 | Query compiler, dashboard API parity, Kafka sink + writers, processors | planned |
| M4 | GitHub/Slack/PagerDuty, alerts, MCP server, AI investigator, anomaly detection | planned |
| M5 | SAML/SCIM, full Helm chart, releases, docs | planned |
| M6 | Cutover from v1 | planned |

## Self-host (quick start)

```sh
cd deploy/compose
cp .env.example .env            # set the passwords and SESSION_SECRET
docker compose up -d --wait
docker compose run --rm --entrypoint /apilens apilens seed   # prints api_key (ingest) and read_key
# put read_key into .env as APILENS_READ_KEY, then:
docker compose up -d console    # dashboard on http://localhost:3100
```

Point an SDK (or any OpenTelemetry exporter at `http://<host>:8080/otlp`) at
the edge. See [deploy/README.md](deploy/README.md) for TLS, upgrades and Helm.

```python
from apilens.fastapi import ApiLensMiddleware
app.add_middleware(ApiLensMiddleware, api_key="apl_live_…", app_id="default",
                   base_url="http://localhost:8080/v1")
```

Existing SDK releases work unchanged against v2: the edge keeps the v1 wire
format byte-for-byte (checked in CI's end-to-end job).

## Develop

You need Go 1.27, Node 22, pnpm 11, uv and Docker ([mise.toml](mise.toml)
pins them).

```sh
go -C tools install tool   # installs task, buf, golangci-lint into ./bin (or `task tools`)
export PATH="$PWD/bin:$PATH"
task bootstrap             # deps, dev datastores, migrations, seed
task run                   # apilens -target=all against the dev datastores
task dev                   # datastores + hot reload backend + web + AI (mprocs)
```

| Command | What it does |
|---|---|
| `task test` | Go unit tests |
| `task test:integration` | Go tests against real Postgres/ClickHouse/Valkey (testcontainers) |
| `task e2e:up && task test:e2e` | black-box tests against the compose stack |
| `task lint` | golangci-lint, govulncheck, buf, ESLint/tsc, ruff/pyright |
| `task gen` | regenerate protobuf, sqlc and OpenAPI (committed; CI checks for drift) |
| `task loadgen -- -key … -rate 50000` | load test the edge ([baseline](docs/benchmarks/m1.md)) |

## Repository layout

```
cmd/apilens          the single binary
internal/            app (composition root), platform, ingest, pipeline, controlplane, migrations, gen
proto/ api/openapi/  contracts
apps/web apps/ai apps/docs
packages/sdk-python packages/sdk-typescript packages/sdk-java
deploy/              docker, compose, helm
docs/                architecture, ADRs, benchmarks
test/e2e tools/      end-to-end tests, dev tooling and load generator
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits, DCO sign-off) and
[GOVERNANCE.md](GOVERNANCE.md). Report vulnerabilities privately as described
in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
