# APILens

API observability — track requests, see performance, get alerts.

> Early-stage. APIs change, things break.

## What's where

```
apps/api          Django backend     → api.apilens.ai
apps/web          Next.js frontend   → app.apilens.ai
apps/docs         Mintlify docs
packages/         Shared TS packages + published SDKs
infra/docker      Local databases (postgres, clickhouse, redis)
infra/gcp         Production infra (Terraform)
```

## Run locally

You need: Node 20+, pnpm 9, Python 3.13, [`uv`](https://docs.astral.sh/uv/), Docker.

```bash
pnpm setup                                # one-shot: install + Python venv + start DBs
pnpm dev                                  # web + any TS workspaces
cd apps/api && source .venv/bin/activate && python manage.py runserver
```

Open http://localhost:3000. Magic links print to the api terminal (console email backend in dev) — copy the link to sign in.

Stop the databases when you're done:

```bash
pnpm db:down
```

## Common commands

```bash
pnpm db:up                                              # start postgres + clickhouse + redis
pnpm db:logs                                            # tail their logs
pnpm typecheck                                          # TS type-check all workspaces
cd apps/api && python manage.py migrate                 # apply Django migrations
cd apps/api && python manage.py clickhouse_migrate      # apply ClickHouse migrations
```

## Production

Cloud Run + Supabase + ClickHouse Cloud + GCS. Bootstrap walkthrough in [`infra/gcp/terraform/README.md`](./infra/gcp/terraform/README.md).

## Contributing

Branch off `main`, open a PR. CI only runs jobs for the workspace(s) you touched.
