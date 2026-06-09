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
pnpm bootstrap
```

This is interactive — it checks your environment, asks before overwriting anything, and walks you through each step:

1. **Pre-flight** — verifies node, pnpm, python, uv, and docker are installed
2. **JS/TS deps** — runs `pnpm install` across all workspaces
3. **Python venv** — creates `apps/api/.venv` and installs backend deps with `uv`
4. **Environment files** — copies `.env.example` → `.env` with real secrets auto-generated (no copy-paste placeholders)
5. **Databases** — starts postgres + clickhouse + redis + the OPA authz engine via Docker, detects port conflicts and offers to remap them
6. **Migrations** — optionally runs Django migrations to get the DB schema ready

Re-run `pnpm bootstrap` after pulling changes that touch dependencies, env templates, or Docker config. It skips steps that are already done.

> **Why `bootstrap` and not `setup`?** `pnpm setup` is a built-in pnpm command (it adds pnpm to your PATH). Running it would silently do nothing instead of running our script.

### Every day, while coding

```bash
pnpm dev
```

That's it. This starts the **whole local stack** in one terminal via `mprocs` — one tab per service: postgres, clickhouse, redis, authz (OPA), api (http://localhost:8000), ingest (http://localhost:8001), and web (http://localhost:3002). Each tab has its own live logs.

Navigation: **`Ctrl+a`** toggles focus between the process list and the output pane; `q` quits (must be focused on the process list), `Q` force-quits, `r` restarts the selected proc.

Magic links print to the `api` tab — copy the link from the logs to sign in.

> Want just the app servers (frontend + Django) the old way, with the databases already up via `pnpm db:up`? Use `pnpm dev:apps` (turbo).

### Once you're done

Quitting `pnpm dev` (`q`) stops the **app servers** (api/ingest/web) instantly. The datastore containers keep running in the background — the same model as `pnpm db:up` — so the next `pnpm dev` starts fast. Stop them when you're fully done:

```bash
pnpm db:down       # stop postgres + clickhouse + redis + opa
```

## Common commands

```bash
pnpm dev                # run the full local stack (mprocs: db + authz + api + ingest + web)
pnpm dev:apps           # run just the app servers (frontend + Django) via turbo
pnpm stack              # alias of `pnpm dev`
pnpm build              # build everything (turbo, cached)
pnpm typecheck          # TS type-check
pnpm lint               # lint JS/TS workspaces

pnpm db:up              # start postgres + clickhouse + redis + opa (detached)
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
