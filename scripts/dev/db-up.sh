#!/usr/bin/env bash
# Bring up local postgres + clickhouse + redis. Same as `pnpm db:up`,
# just nicer to type when you're already in a shell.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec docker compose -f "$REPO_ROOT/infrastructure/docker/docker-compose.local.yml" up -d "$@"
