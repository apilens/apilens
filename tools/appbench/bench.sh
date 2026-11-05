#!/usr/bin/env bash
# SDK overhead on the three example apps: the same load against each app with
# no middleware (posture `off`) and with the metadata, redacted and full
# capture profiles, at 1 KB and 32 KB JSON bodies. Writes off.json ...
# full.json, overhead.md and overhead.json to the output directory.
#
# Usage (after `task examples:up`, which writes examples/.env):
#   tools/appbench/bench.sh [out_dir]          # or: task bench:examples
#
# Environment:
#   APILENS_EXAMPLES_API_KEY   ingest key (default: read from examples/.env)
#   APPBENCH_POSTURES          postures to run (default "off metadata redacted full")
#   APPBENCH_RUN_ARGS          extra `appbench run` flags, e.g. "-duration 30s -concurrency 8"
#   APPBENCH_REPORT_ARGS       extra `appbench report` flags, e.g. "-fail-on-threshold"
#
# Each posture recreates only the example-* containers (the e2e stack keeps
# running). The apps are left on the last posture; `task examples:up`
# restores the default.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
mkdir -p "${1:-bin/appbench}"
out="$(cd "${1:-bin/appbench}" && pwd)"

key="${APILENS_EXAMPLES_API_KEY:-}"
if [ -z "$key" ] && [ -f examples/.env ]; then
  key="$(sed -n 's/^APILENS_EXAMPLES_API_KEY=//p' examples/.env)"
fi
if [ -z "$key" ]; then
  echo "bench: no APILENS_EXAMPLES_API_KEY and no examples/.env; run task examples:up first" >&2
  exit 1
fi

compose=(docker compose --env-file deploy/compose/ci.env
  -f deploy/compose/compose.yaml -f deploy/compose/compose.ci.yaml
  -f deploy/compose/compose.examples.yaml --profile examples)
apps=(fastapi express spring)
port() {
  case "$1" in
    fastapi) echo "${APILENS_EXAMPLES_FASTAPI_PORT:-18001}" ;;
    express) echo "${APILENS_EXAMPLES_EXPRESS_PORT:-18002}" ;;
    spring) echo "${APILENS_EXAMPLES_SPRING_PORT:-18003}" ;;
  esac
}

bench="$out/appbench-bin"
go -C tools build -o "$bench" ./appbench

read -r -a run_args <<<"${APPBENCH_RUN_ARGS:-}"
read -r -a report_args <<<"${APPBENCH_REPORT_ARGS:-}"
read -r -a postures <<<"${APPBENCH_POSTURES:-off metadata redacted full}"

results=()
for posture in "${postures[@]}"; do
  echo "== posture $posture"
  APILENS_EXAMPLES_POSTURE="$posture" APILENS_EXAMPLES_API_KEY="$key" \
    "${compose[@]}" up -d --no-deps --no-build --force-recreate --wait --wait-timeout 600 \
    example-fastapi example-express example-spring

  flags=(-posture "$posture" -out "$out/$posture.json")
  for app in "${apps[@]}"; do
    url="http://127.0.0.1:$(port "$app")"
    # The apps report their posture on /health: fail fast on a stale container.
    got="$(curl -fsS --max-time 10 "$url/health" | sed -n 's/.*"posture" *: *"\([a-z]*\)".*/\1/p')"
    if [ "$got" != "$posture" ]; then
      echo "bench: $app reports posture '$got', want '$posture'" >&2
      exit 1
    fi
    container="$(APILENS_EXAMPLES_API_KEY=unused "${compose[@]}" ps -q "example-$app")"
    flags+=(-target "$app=$url" -docker "$app=$container")
  done
  "$bench" run "${flags[@]}" ${run_args[@]+"${run_args[@]}"}
  results+=("$out/$posture.json")
done

"$bench" report -o "$out/overhead.md" -json "$out/overhead.json" \
  ${report_args[@]+"${report_args[@]}"} "${results[@]}"
echo "report: $out/overhead.md"
