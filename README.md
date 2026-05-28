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

- **Node 20+** — [nodejs.org](https://nodejs.org)
- **pnpm 9** — see install instructions below
- **Python 3.13** — [python.org](https://python.org)
- **uv** — [astral.sh/uv](https://docs.astral.sh/uv/)
- **Docker** — [docs.docker.com/get-docker](https://docs.docker.com/get-docker)

### Installing pnpm

pnpm is the package manager for all JS/TS workspaces. The recommended way is via Node's built-in corepack:

```bash
corepack enable
corepack prepare pnpm@9 --activate
```

Or install it globally with npm:

```bash
npm install -g pnpm@9
```

Verify it worked:

```bash
pnpm --version   # should print 9.x.x
```

> If you're using [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm), run `corepack enable` after switching Node versions — corepack shims are per Node install.

## Run it locally

There are two commands you'll use. `setup` is one-time, `dev` is every day.

### First time only

After cloning the repo:

```bash
pnpm setup
```

This is interactive — it checks your environment, asks before overwriting anything, and walks you through each step:

1. **Pre-flight** — verifies node, pnpm, python, uv, and docker are installed
2. **JS/TS deps** — runs `pnpm install` across all workspaces
3. **Python venv** — creates `apps/api/.venv` and installs backend deps with `uv`
4. **Environment files** — copies `.env.example` → `.env` with real secrets auto-generated (no copy-paste placeholders)
5. **Databases** — starts postgres + clickhouse + redis via Docker, detects port conflicts and offers to remap them
6. **Migrations** — optionally runs Django migrations to get the DB schema ready

Re-run `pnpm setup` after pulling changes that touch dependencies, env templates, or Docker config. It skips steps that are already done.

### Every day, while coding

**Option A — one terminal (simplest):**

```bash
bash scripts/dev/dev-up.sh
```

This starts the databases, boots the Next.js dev server in the background, and runs Django in the foreground. Ctrl-C stops everything.

**Option B — two terminals (cleaner logs):**

Terminal 1 — frontend (Next.js on http://localhost:3002):

```bash
pnpm dev
```

Terminal 2 — backend (Django on http://localhost:8000):

```bash
cd apps/api
.venv/bin/python manage.py runserver
```

Magic links print to the Django terminal in dev — copy the link from the logs to sign in.

### Once you're done

```bash
pnpm db:down       # stop the local databases
```

To resume the next day: `pnpm db:up` brings the databases back, then run either dev option above.

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

Backend (from `apps/api/`):

```bash
.venv/bin/python manage.py runserver
.venv/bin/python manage.py migrate                # apply Django migrations
.venv/bin/python manage.py clickhouse_migrate     # apply ClickHouse migrations
.venv/bin/python manage.py createsuperuser        # add an admin
```

## Repo conventions

- pnpm workspaces are everything under `apps/*` and `packages/*` with a `package.json`.
- Python apps + Dart SDK are workspace-invisible to pnpm — `uv` and `pub` manage those.
- CI runs only on the workspace you touched (path-filtered).
- Each app has its own `.env` (start from `.env.example`).

## Contributing

Branch off `main`, open a PR. CI runs only on the workspaces you changed. The PR description should say what changed and why; a quick test plan helps.
