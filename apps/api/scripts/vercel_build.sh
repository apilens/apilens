#!/usr/bin/env sh
set -eu

if [ "${VERCEL_ENV:-}" != "production" ]; then
  exit 0
fi

python manage.py makemigrations --noinput
python manage.py migrate --noinput

if [ -n "${APILENS_CLICKHOUSE_URL:-}" ] || \
   [ -n "${APILENS_CLICKHOUSE_HOST:-}" ] || \
   [ -n "${CLICKHOUSE_URL:-}" ] || \
   [ -n "${CLICKHOUSE_HOST:-}" ]; then
  python manage.py clickhouse_migrate
fi
