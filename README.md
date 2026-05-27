# APILens

> **This project is under active development. There is no first release yet.**
> Things will break, APIs will change, and features are incomplete.
> If you'd like to contribute, you're warmly welcome — see [Contributing](#contributing) below.

APILens is an API observability platform — track requests, analyze performance, get alerts when things break.

## Layout

```
apilens/
├── apps/
│   ├── api/                  Django + Ninja backend       →  api.apilens.ai
│   ├── web/                  Next.js frontend             →  app.apilens.ai
│   └── docs/                 Mintlify documentation
├── packages/
│   ├── logger/               @apilens/logger — shared TS/JS logger (pino)
│   ├── sdk-python/           PyPI: apilenss
│   └── sdk-typescript/       npm:  apilens-js-sdk
├── infra/
│   ├── docker/               Local-dev docker-compose (postgres, clickhouse, redis)
│   └── gcp/terraform/        Production infra (Cloud Run, GCS, LB, Secrets, IAM)
├── sidecar-testing/          Local SDK integration tests across frameworks
└── scripts/                  Setup + dev helpers
```

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.13, Django 5, Django Ninja |
| Frontend | Next.js 16, React 19, TypeScript |
| Database | PostgreSQL (Supabase in prod, docker locally) |
| Analytics DB | ClickHouse (Cloud in prod, docker locally) |
| Cache / queue | Redis |
| Storage | GCS bucket (public-read for media) |
| Mail | Resend (SMTP relay) |
| Hosting | GCP Cloud Run + Global HTTPS LB |
| Infra-as-code | Terraform |
| Monorepo | pnpm workspaces + turborepo (JS/TS only) |

## Quickstart

Prerequisites: Node 20 (`.nvmrc`), pnpm 9, Python 3.13, [`uv`](https://docs.astral.sh/uv/), Docker.

```bash
pnpm setup                # installs deps, creates Python venv, starts databases
pnpm dev                  # runs all JS/TS dev servers via turbo
# In a second terminal:
cd apps/api && source .venv/bin/activate && python manage.py runserver
```

The Django dev server uses console email by default — magic links get printed to the api terminal (look for the link in the output and paste it into your browser).

Stop the databases: `pnpm db:down`.

## Daily commands

| Command | What |
|---|---|
| `pnpm dev` | Turbo runs `dev` across JS/TS workspaces |
| `pnpm build` | Turbo build (cached) |
| `pnpm typecheck` | TS type-check |
| `pnpm lint` | Lint all JS/TS workspaces |
| `pnpm db:up` / `db:down` / `db:logs` | Local postgres + clickhouse + redis |
| `cd apps/api && python manage.py runserver` | Django dev server |
| `cd apps/api && python manage.py migrate` | Django migrations |
| `cd apps/api && python manage.py clickhouse_migrate` | ClickHouse migrations |

## Production

- **Frontend** → Cloud Run `apilens-prod-frontend` → `app.apilens.ai`
- **Backend** → Cloud Run `apilens-prod-backend` → `api.apilens.ai`
- **Databases** → Supabase Postgres + ClickHouse Cloud
- **Storage** → GCS bucket `${project}-media` (public-read)
- **Mail** → Resend SMTP
- **Infra** → `infra/gcp/terraform/`

See [`infra/gcp/terraform/README.md`](./infra/gcp/terraform/README.md) for the bootstrap walkthrough.

## Repo conventions

- pnpm workspace globs are `apps/*` and `packages/*`. Anything with a `package.json` becomes a workspace member.
- Python apps and the Dart SDK are workspace-invisible to pnpm — `uv` / `pub` manage those independently.
- CI uses GitHub Actions path filters; a docs change won't trigger backend CI.
- **Production Cloud Run service names + Artifact Registry image paths are NOT renamed** even though source dirs are now `apps/api` / `apps/web`. The service name `apilens-prod-backend` and image path `apilens/backend` stay stable to avoid destroy+create downtime.

## Contributing

PR each change behind a feature branch off `main`. CI checks the affected workspace(s) only.

## License

MIT.
