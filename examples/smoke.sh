#!/usr/bin/env bash
# Drive every endpoint of the three example apps once and check each status.
# Usage: examples/smoke.sh [base_url ...]
# Defaults to the ports deploy/compose/compose.examples.yaml publishes.
#
# APILENS_SMOKE_RESOURCES=1 also checks the runtime resources the SDKs sent
# (M7), for apps started with APILENS_EXAMPLES_LIMITS=1 (half a core, 256 MiB,
# compose.examples.limits.yaml). Read from ClickHouse app_instance_resources:
#   - every heartbeat's resources say limit_source cgroup_v2, a 0.5-core CPU
#     limit and a 256 MiB memory limit;
#   - the 4 gunicorn workers (2 Node cluster workers) are separate instances
#     sharing one container_id, and their container memory is one figure for
#     the container: never above the limit, the same for every worker (not
#     each worker's share times four).
# Knobs (defaults match the CI stack):
#   APILENS_E2E_CLICKHOUSE_HTTP / _USER / _PASSWORD   ClickHouse HTTP
#   APILENS_EXAMPLES_ENVIRONMENT                      environment the apps report
#   APILENS_SMOKE_RESOURCES_TIMEOUT                   seconds to wait (default 240)
#   APILENS_SMOKE_MIN_INSTANCES  "sdk=n ..." (default apilenss=4 apilens-js-sdk=2 apilens-java-sdk=1)
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
  check 500 "GET /boom/chained" "$base/boom/chained"
  check 500 "GET /boom/deep" "$base/boom/deep"
  check 500 "GET /boom/handled" "$base/boom/handled"
  check 200 "GET /boom/logged" "$base/boom/logged"
  check 200 "GET /outbound" "$base/outbound"
  check 200 "GET /leak (1 MiB)" "$base/leak?mb=1"
  check 422 "GET /leak (too much)" "$base/leak?mb=4096"
  check 200 "GET /burn (50 ms)" "$base/burn?ms=50"
done

# ---------------------------------------------------------------- resources
if [ -n "${APILENS_SMOKE_RESOURCES:-}" ]; then
  ch_url="${APILENS_E2E_CLICKHOUSE_HTTP:-http://127.0.0.1:8123}"
  ch_user="${APILENS_E2E_CLICKHOUSE_USER:-apilens}"
  ch_password="${APILENS_E2E_CLICKHOUSE_PASSWORD:-ci-clickhouse}"
  env_name="${APILENS_EXAMPLES_ENVIRONMENT:-production}"
  timeout_s="${APILENS_SMOKE_RESOURCES_TIMEOUT:-240}"
  mib256=268435456

  ch() {
    curl -sS --fail-with-body --max-time 15 -u "$ch_user:$ch_password" \
      --data-binary "$1" "$ch_url/?default_format=TSV"
  }

  # One line per SDK over the last 10 minutes of this environment:
  # rows instances containers max_instances_per_container bad_source bad_cpu
  # bad_mem over_limit spread (max/min container memory across workers of a
  # container, per heartbeat minute).
  resources_report() {
    local sdk="$1"
    ch "
      WITH rows AS (
        SELECT instance_id, container_id, limit_source, metrics, toStartOfMinute(ts) AS minute
        FROM app_instance_resources
        WHERE sdk_name = '$sdk' AND environment = '$env_name'
          AND ts > now() - INTERVAL 10 MINUTE AND samples > 0
      ),
      per_minute AS (
        SELECT container_id, minute,
               max(metrics['container.memory.current.avg']) / nullIf(min(metrics['container.memory.current.avg']), 0) AS spread
        FROM rows
        WHERE mapContains(metrics, 'container.memory.current.avg')
        GROUP BY container_id, minute
        HAVING uniqExact(instance_id) > 1
      )
      SELECT
        (SELECT count() FROM rows),
        (SELECT uniqExact(instance_id) FROM rows),
        (SELECT uniqExact(container_id) FROM rows WHERE container_id != ''),
        (SELECT max(n) FROM (SELECT uniqExact(instance_id) AS n FROM rows WHERE container_id != '' GROUP BY container_id)),
        (SELECT countIf(limit_source != 'cgroup_v2') FROM rows),
        (SELECT countIf(NOT mapContains(metrics, 'container.cpu.limit_cores')
                        OR abs(metrics['container.cpu.limit_cores'] - 0.5) > 0.001) FROM rows),
        (SELECT countIf(NOT mapContains(metrics, 'container.memory.limit')
                        OR metrics['container.memory.limit'] != $mib256) FROM rows),
        (SELECT countIf(mapContains(metrics, 'container.memory.current.max')
                        AND metrics['container.memory.current.max'] > $mib256) FROM rows),
        (SELECT round(ifNull(max(spread), 1), 3) FROM per_minute)
    " | tr '\t' ' '
  }

  want_instances() {
    local sdk="$1" pair
    for pair in ${APILENS_SMOKE_MIN_INSTANCES:-apilenss=4 apilens-js-sdk=2 apilens-java-sdk=1}; do
      if [ "${pair%%=*}" = "$sdk" ]; then
        echo "${pair#*=}"
        return
      fi
    done
    echo 1
  }

  echo "runtime resources (ClickHouse $ch_url, environment $env_name)"
  for sdk in apilenss apilens-js-sdk apilens-java-sdk; do
    want="$(want_instances "$sdk")"
    deadline=$((SECONDS + timeout_s))
    report=""
    # Heartbeats come about once a minute; the first may predate the first sample.
    while :; do
      report="$(resources_report "$sdk" || true)"
      read -r rows instances containers per_container _ <<<"${report:-0 0 0 0}"
      if [ "${per_container:-0}" -ge "$want" ] 2>/dev/null && [ "${rows:-0}" -ge "$want" ]; then
        break
      fi
      if [ "$SECONDS" -ge "$deadline" ]; then
        break
      fi
      sleep 10
    done
    read -r rows instances containers per_container bad_source bad_cpu bad_mem over_limit spread <<<"${report:-0 0 0 0 0 0 0 0 0}"
    label="$sdk: $rows heartbeats, $instances instances, $containers containers"
    if [ "${per_container:-0}" -ge "$want" ] 2>/dev/null; then
      printf '  ok   %s (%s workers share one container)\n' "$label" "$per_container"
    else
      printf '  FAIL %s (want %s instances in one container, got %s)\n' "$label" "$want" "${per_container:-0}"
      failures=$((failures + 1))
      continue
    fi
    for pair in "limit_source cgroup_v2:$bad_source" "CPU limit 0.5 core:$bad_cpu" \
      "memory limit 256 MiB:$bad_mem" "container memory within the limit:$over_limit"; do
      if [ "${pair##*:}" = "0" ]; then
        printf '  ok   %s %s\n' "$sdk" "${pair%:*}"
      else
        printf '  FAIL %s %s (%s heartbeats disagree)\n' "$sdk" "${pair%:*}" "${pair##*:}"
        failures=$((failures + 1))
      fi
    done
    # Workers of one container report the container's memory, not a share of
    # it: within a minute they agree (a sum of 4 workers would be ~4x apart).
    if awk -v s="${spread:-1}" 'BEGIN { exit !(s <= 1.5) }'; then
      printf '  ok   %s container memory is one figure per container (max/min across workers %s)\n' "$sdk" "$spread"
    else
      printf '  FAIL %s container memory differs %sx across workers of one container\n' "$sdk" "$spread"
      failures=$((failures + 1))
    fi
  done
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all example endpoints answered as expected"
