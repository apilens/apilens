#!/usr/bin/env bash
# Start everything for local development:
#   1. databases (docker compose)
#   2. backend (Django, in foreground)
#   3. frontend (Next.js, in foreground — opens a second terminal pane if tmux is around)
#
# Prefer running api + web in separate terminals so logs are readable.
# This script exists to make the daily flow one command if you don't want
# the extra terminals.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

bash scripts/dev/db-up.sh

# Run frontend dev server in background; tail logs interleaved with api.
echo
echo "→ Starting frontend (apps/web) in background…"
(cd apps/web && pnpm dev) > /tmp/apilens-web.log 2>&1 &
WEB_PID=$!
echo "  (logs at /tmp/apilens-web.log, pid=$WEB_PID)"

trap "echo; echo '→ stopping frontend (pid=$WEB_PID)…'; kill $WEB_PID 2>/dev/null || true" EXIT

echo "→ Starting api (apps/api) in foreground. Ctrl-C to stop everything."
echo
cd apps/api
# shellcheck source=/dev/null
source .venv/bin/activate
python manage.py runserver
