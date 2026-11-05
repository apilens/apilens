#!/usr/bin/env bash
# Drive every endpoint of the three example apps once and check each status.
# Usage: examples/smoke.sh [base_url ...]
# Defaults to the ports deploy/compose/compose.examples.yaml publishes.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  set -- \
    "http://127.0.0.1:${APILENS_EXAMPLES_FASTAPI_PORT:-18001}" \
    "http://127.0.0.1:${APILENS_EXAMPLES_EXPRESS_PORT:-18002}" \
    "http://127.0.0.1:${APILENS_EXAMPLES_SPRING_PORT:-18003}"
fi

upload_file="$(mktemp)"
trap 'rm -f "$upload_file"' EXIT
printf 'example upload\n' >"$upload_file"

failures=0

# check <want> <label> <curl args...>
check() {
  local want="$1" label="$2"
  shift 2
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" || true)"
  if [ "$got" = "$want" ]; then
    printf '  ok   %s %s\n' "$got" "$label"
  else
    printf '  FAIL %s %s (want %s)\n' "$got" "$label" "$want"
    failures=$((failures + 1))
  fi
}

for base in "$@"; do
  echo "$base"
  check 200 "GET /health" "$base/health"
  check 200 "GET /orders/{id}" "$base/orders/42"
  check 201 "POST /orders (json)" -H 'Content-Type: application/json' \
    -d '{"item":"widget","quantity":2,"email":"ada@example.com","card_number":"4111111111111111"}' \
    "$base/orders"
  check 422 "POST /orders (invalid)" -H 'Content-Type: application/json' \
    -d '{"item":"","quantity":0}' "$base/orders"
  check 200 "POST /login (form)" --data-urlencode 'username=ada@example.com' \
    --data-urlencode 'password=hunter2' "$base/login"
  check 200 "POST /upload (multipart)" -F "file=@$upload_file;filename=note.txt" \
    -F 'description=smoke' "$base/upload"
  check 500 "GET /boom" "$base/boom"
  check 200 "GET /outbound" "$base/outbound"
done

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all example endpoints answered as expected"
