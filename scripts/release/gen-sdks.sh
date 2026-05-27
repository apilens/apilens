#!/usr/bin/env bash
# Regenerate the committed OpenAPI snapshot and produce SDK clients from it.
#
# Usage:
#   bash scripts/release/gen-sdks.sh                     # uses local dev API
#   API_URL=https://api.apilens.ai bash scripts/...      # snapshot from prod

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

API_URL="${API_URL:-http://localhost:8000}"
SCHEMA_PATH="schemas/openapi/openapi.yaml"

echo "→ Fetching OpenAPI spec from ${API_URL}/api/v1/openapi.json"
curl -fsS "${API_URL}/api/v1/openapi.json" -o /tmp/apilens-openapi.json

echo "→ Converting JSON → YAML at ${SCHEMA_PATH}"
python3 - <<PY
import json, yaml
with open("/tmp/apilens-openapi.json") as f:
    spec = json.load(f)
with open("${SCHEMA_PATH}", "w") as f:
    yaml.safe_dump(spec, f, sort_keys=False, default_flow_style=False, width=120)
PY

rm /tmp/apilens-openapi.json

echo ""
echo "→ Schema updated."
echo ""
echo "TypeScript SDK generation is not yet wired up — when ready, drop a"
echo "  pnpm dlx @hey-api/openapi-ts -i $SCHEMA_PATH -o packages/sdk-typescript/src/generated"
echo "call here. Python and Dart SDKs will plug in beside it."
echo ""
echo "Commit ${SCHEMA_PATH} when the contract has actually changed."
