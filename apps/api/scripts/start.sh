#!/bin/bash
set -e

echo "[start] Running Django migrations..."
python manage.py migrate --noinput

if [ -n "${APILENS_CLICKHOUSE_URL:-}" ] || \
   [ -n "${APILENS_CLICKHOUSE_HOST:-}" ] || \
   [ -n "${CLICKHOUSE_URL:-}" ] || \
   [ -n "${CLICKHOUSE_HOST:-}" ]; then
  echo "[start] Running ClickHouse migrations..."
  python manage.py clickhouse_migrate || echo "[start] ClickHouse migration skipped (not available)"
fi

echo "[start] Starting Gunicorn..."
exec gunicorn config.wsgi:application \
  --bind "0.0.0.0:${PORT:-8000}" \
  --workers "${GUNICORN_WORKERS:-2}" \
  --threads "${GUNICORN_THREADS:-4}" \
  --timeout 120 \
  --access-logfile - \
  --error-logfile - \
  --log-level info
