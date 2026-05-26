# Follow-ups

Items deliberately deferred during the 2026-05-26 cleanup pass because they
need their own design discussion or wider scope than a chore PR should carry.

## Backend

### `backend/config/settings.py` — env-var fallback chains

`APILENS_DATABASE_URL` reads from 4 different env names (`APILENS_POSTGRES_URL`,
`APILENS_DATABASE_URL_UNPOOLED`, `APILENS_POSTGRES_URL_NON_POOLING`, …), and
each piece of database config reads from 3 (`APILENS_PG*`, `POSTGRES_*`, …).
This grew organically across multiple host migrations.

Before deleting: do an inventory of which names each environment (local dev,
GCP Cloud Run prod, anyone's machine) actually sets, then pick one canonical
name per setting and remove the rest. Risky to delete blind — a forgotten
alias could silently break a deploy.

### Backend test coverage

`backend/tests/` is empty. CI is currently soft-failing the pytest job
(`exit code 5: no tests collected`). When we have real tests, drop the
soft-fail in `.github/workflows/backend-ci.yml`.

## Frontend

### `eslint-config-next` 16 + ESLint 9 flat config

`npm run lint` hits a circular-JSON validation bug via FlatCompat. The
workflow is currently set to `npm run lint || echo "::warning::..."`. Once
the upstream config is fixed (or we replace eslint-config-next), drop the
soft-fail in `.github/workflows/frontend-ci.yml`.

## Infrastructure

### Supabase: direct connection → pooler

`apilens-database-url` Secret Manager entry currently points at port 5432
(direct Supabase Postgres). Cloud Run is serverless/bursty and should use the
**transaction pooler on port 6543** to avoid exhausting `max_connections`.

Swap with:

```bash
echo -n 'postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require' | \
  gcloud secrets versions add apilens-database-url --data-file=-
```

Find the actual pooler DSN in Supabase dashboard → Connect → Transaction pooler.

### `apps/endpoints` Django app

Empty app kept in `INSTALLED_APPS` for migration history only (the `Endpoint`
model was moved into `apps/projects`). Future cleanup: squash migrations
across `endpoints` + `projects`, then remove the `apps/endpoints/` directory
entirely. Not urgent.
