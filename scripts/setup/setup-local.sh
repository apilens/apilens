#!/usr/bin/env bash
# One-shot local-dev bootstrap for APILens.
#
# Run: `pnpm setup`  (or: `bash scripts/setup/setup-local.sh`)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1" >&2; }

# 1. JS/TS workspaces
bold "Installing JS/TS deps (pnpm)…"
if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found. Install via: corepack enable && corepack prepare pnpm@9 --activate"
  exit 1
fi
pnpm install
ok "pnpm install complete"

# 2. Python venv for the API
bold "Setting up Python venv for apps/api…"
if ! command -v uv >/dev/null 2>&1; then
  warn "uv not found. Install via: curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi
(
  cd apps/api
  uv venv .venv
  # shellcheck source=/dev/null
  source .venv/bin/activate
  uv pip install -e .
)
ok "apps/api venv ready (.venv inside apps/api)"

# 3. Env templates
bold "Seeding .env files from examples…"
for app in apps/api apps/web; do
  if [[ -f "$app/.env.example" && ! -f "$app/.env" ]]; then
    cp "$app/.env.example" "$app/.env"
    ok "$app/.env created (review + edit values)"
  fi
done

# 4. Local databases
bold "Starting local databases (docker compose)…"
if ! command -v docker >/dev/null 2>&1; then
  warn "docker not found. Skip db step; install Docker Desktop or equivalent."
else
  docker compose -f infrastructure/docker/docker-compose.local.yml up -d
  ok "postgres + clickhouse + redis up on standard ports (5432 / 8123+9000 / 6379)"
fi

echo
bold "Done. Common next commands:"
cat <<'EOF'
  pnpm dev                    # turbo: dev tasks across TS/JS workspaces
  cd apps/api && source .venv/bin/activate && python manage.py runserver
  pnpm db:down                # stop the dbs when you're done
  pnpm sdks:generate          # refresh the OpenAPI snapshot from a running API
EOF
