#!/bin/bash
set -e

echo "[ingest] Starting Gunicorn (uvicorn workers)…"
exec gunicorn app.main:app \
  -k uvicorn.workers.UvicornWorker \
  --bind "0.0.0.0:${PORT:-8000}" \
  --workers "${GUNICORN_WORKERS:-2}" \
  --timeout 60 \
  --access-logfile - \
  --error-logfile - \
  --log-level info
