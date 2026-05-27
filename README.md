# APILens

API observability — track requests, see performance, get alerts when things break.

> Early-stage. APIs change, things break.

## What's in the repo

```
apps/
  api          Django + Ninja backend
  web          Next.js frontend
  docs         Mintlify docs
packages/
  logger             @apilens/logger — shared TS logger (pino)
  sdk-python         PyPI: apilenss
  sdk-typescript     npm:  apilens-js-sdk
infra/
  docker       Local databases (postgres, clickhouse, redis)
  gcp          Production infra (Terraform)
scripts/       Setup + dev helpers
sidecar-testing/   Local SDK integration tests across frameworks
```

## Tech

- **Backend**: Python 3.13, Django 5, Django Ninja
- **Frontend**: Next.js 16, React 19, TypeScript
- **Databases**: Postgres + ClickHouse + Redis
- **Monorepo**: pnpm workspaces + turborepo (JS/TS only — Python uses uv)

## You'll need

- Node 20+ and pnpm 9
- Python 3.13 and [`uv`](https://docs.astral.sh/uv/)
- Docker

## Run it locally

There are two commands you'll use. `setup` is one-time, `dev` is every day.

### First time only

After cloning the repo:

```bash
pnpm setup
```

This does four things:

1. `pnpm install` — installs JS/TS dependencies
2. Creates the Python venv at `apps/api/.venv` and installs backend deps with `uv`
3. Copies `.env.example` → `.env` in each app so you have a config to edit
4. Starts the local databases (postgres + clickhouse + redis) via Docker

You only re-run `setup` after pulling changes that touch dependencies, env templates, or Docker config.

### Every day, while coding

You need **two terminals** — one for the frontend, one for the backend. The frontend runs through pnpm; the backend is Python and lives outside the pnpm world.

**Terminal 1 — frontend (Next.js):**

```bash
pnpm dev
```

This runs `turbo run dev`, which boots the Next.js dev server on http://localhost:3000. (It does *not* touch the databases or the Python backend.)

**Terminal 2 — backend (Django):**

```bash
cd apps/api
source .venv/bin/activate
python manage.py runserver
```

Magic links print to this terminal (console email backend in dev) — copy the link from the logs to sign in.

### Once you're done

```bash
pnpm db:down       # stop the local databases
```

If you closed the terminals and want them back next day: `pnpm db:up` brings the databases back, then run the two dev commands above.

## Common commands

```bash
pnpm dev                # run JS/TS dev servers
pnpm build              # build everything (turbo, cached)
pnpm typecheck          # TS type-check
pnpm lint               # lint JS/TS workspaces

pnpm db:up              # start postgres + clickhouse + redis
pnpm db:down            # stop them
pnpm db:logs            # tail their logs
```

Backend (`cd apps/api && source .venv/bin/activate` first):

```bash
python manage.py runserver
python manage.py migrate                # apply Django migrations
python manage.py clickhouse_migrate     # apply ClickHouse migrations
python manage.py createsuperuser        # add an admin
```

## Repo conventions

- pnpm workspaces are everything under `apps/*` and `packages/*` with a `package.json`.
- Python apps + Dart SDK are workspace-invisible to pnpm — `uv` and `pub` manage those.
- CI runs only on the workspace you touched (path-filtered).
- Each app has its own `.env` (start from `.env.example`).

## Contributing

Branch off `main`, open a PR. CI runs only on the workspaces you changed. The PR description should say what changed and why; a quick test plan helps.
