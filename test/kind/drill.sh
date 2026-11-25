#!/usr/bin/env bash
# Runtime-resources drill on kind (M7, #1140): limits, OOM kill, restart and
# pod replacement, asserted from what APILens stored. No browser.
#
#   task e2e:up            # the APILens stack (compose CI settings) on this host
#   test/kind/drill.sh     # or: task test:kind:drill
#
# Steps:
#   1. Seed an ingest key, create a kind cluster, build and load the FastAPI
#      example image, and deploy test/kind/example-fastapi.yaml: Downward API
#      identity, limits 500m / 256Mi, gunicorn --preload -w 2.
#   2. Identity and limits: both workers report pod name/uid, namespace,
#      node, platform k8s, one container_id, limit_source cgroup_v2, a 0.5-core
#      and a 256 MiB limit, and the same container memory (never summed).
#   3. OOM kill: /leak to >= 92 % of the limit, wait until a heartbeat stored
#      it, then leak past the limit. The kubelet restarts the container; its
#      instances must end as oom or suspected_oom, with an event.
#   4. Restart: SIGKILL the new container through the node's CRI (crictl stop
#      -t 0). Its instances must end as restart, with an event.
#   5. kubectl delete pod: the replacement is a new pod (new pod uid), so no
#      restart is inferred; the old workers' final heartbeats end them as
#      graceful.
#
# Assertions read Postgres (app_instances, app_instance_events) through the
# compose stack, and GET /api/v1/apps/{id}/instance-events too when the
# server has it.
#
# Environment:
#   APILENS_DRILL_CLUSTER   kind cluster name (default apilens-drill)
#   APILENS_DRILL_ENV       environment the app reports (default kind-drill-<epoch>)
#   APILENS_DRILL_KEEP=1    keep the cluster afterwards
#   APILENS_INGEST_PORT     the stack's API port on this host (default 8080)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

cluster="${APILENS_DRILL_CLUSTER:-apilens-drill}"
env_name="${APILENS_DRILL_ENV:-kind-drill-$(date +%s)}"
image="apilens-example-fastapi:kind"
ns="apilens-drill"
limit=268435456 # 256 MiB
api="http://127.0.0.1:${APILENS_INGEST_PORT:-8080}"
compose=(docker compose --env-file deploy/compose/ci.env -f deploy/compose/compose.yaml -f deploy/compose/compose.ci.yaml)

failures=0
log() { printf '\n==> %s\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
bad() {
  printf '  FAIL %s\n' "$*"
  failures=$((failures + 1))
}
warn() { printf '  WARN %s\n' "$*"; }
# expect <ok message> <failure message> <test command...>
expect() {
  local yes="$1" no="$2"
  shift 2
  if "$@"; then ok "$yes"; else bad "$no"; fi
}
die() {
  printf 'FATAL %s\n' "$*" >&2
  dump
  exit 1
}

psql_q() {
  "${compose[@]}" exec -T postgres psql -U apilens -d apilens -AtX -v ON_ERROR_STOP=1 -c "$1"
}

# wait_until <seconds> <description> <command...>: poll every 5 s.
wait_until() {
  local timeout="$1" what="$2"
  shift 2
  local deadline=$((SECONDS + timeout))
  until "$@"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep 5
  done
  printf '  ...  %s\n' "$what"
}

dump() {
  echo "--- pods" >&2
  kubectl -n "$ns" get pods -o wide >&2 || true
  kubectl -n "$ns" describe pods >&2 || true
  echo "--- app_instances ($env_name)" >&2
  psql_q "SELECT instance_id, pod_name, container_id, ended_reason, last_seen_at,
                 resources -> 'metrics' ->> 'container.memory.working_set.max'
          FROM app_instances WHERE environment = '$env_name' ORDER BY first_seen_at" >&2 || true
  echo "--- app_instance_events ($env_name)" >&2
  psql_q "SELECT kind, instance_id, container_id, at FROM app_instance_events
          WHERE environment = '$env_name' ORDER BY at" >&2 || true
  kubectl -n "$ns" logs deploy/example-fastapi --tail 50 >&2 || true
}

cleanup() {
  if [ -z "${APILENS_DRILL_KEEP:-}" ]; then
    kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------ setup
log "seed an ingest key"
out="$("${compose[@]}" run --rm --no-deps --entrypoint /apilens apilens seed -app-slug example-fastapi | tail -n 1)"
key="$(printf '%s' "$out" | sed -n 's/.*"api_key":"\([^"]*\)".*/\1/p')"
read_key="$(printf '%s' "$out" | sed -n 's/.*"read_key":"\([^"]*\)".*/\1/p')"
[ -n "$key" ] || die "seed did not return an api_key: $out"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::$key"
  [ -z "$read_key" ] || echo "::add-mask::$read_key"
fi

log "kind cluster $cluster"
if ! kind get clusters 2>/dev/null | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --config test/kind/kind-config.yaml --wait 180s
fi
kubectl config use-context "kind-$cluster" >/dev/null
node="$cluster-control-plane"

log "build and load $image"
docker build -q -f examples/fastapi/Dockerfile -t "$image" . >/dev/null
kind load docker-image "$image" --name "$cluster"

# Pods reach the stack's apilens container on the kind network.
apilens_cid="$("${compose[@]}" ps -q apilens)"
[ -n "$apilens_cid" ] || die "the apilens container is not running (task e2e:up first)"
docker network connect kind "$apilens_cid" 2>/dev/null || true
apilens_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}' "$apilens_cid")"
[ -n "$apilens_ip" ] || die "could not attach the apilens container to the kind network"
base_url="http://$apilens_ip:8080/v1"

log "deploy (environment $env_name, ingest $base_url)"
kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$ns" create secret generic apilens-ingest --from-literal=api-key="$key" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
sed -e "s#\${APILENS_BASE_URL}#$base_url#" -e "s#\${APILENS_ENVIRONMENT}#$env_name#" \
  -e "s#\${EXAMPLE_IMAGE}#$image#" test/kind/example-fastapi.yaml | kubectl apply -f -
kubectl -n "$ns" rollout status deploy/example-fastapi --timeout 240s

pod_json() { kubectl -n "$ns" get pod -l app=example-fastapi -o "jsonpath=$1"; }
pod="$(pod_json '{.items[0].metadata.name}')"
uid="$(pod_json '{.items[0].metadata.uid}')"
restarts() { kubectl -n "$ns" get pod "$pod" -o 'jsonpath={.status.containerStatuses[0].restartCount}'; }
restarted_since() { [ "$(restarts)" -gt "$1" ]; }

# req <path>: one GET from inside the pod (no port-forward to break on a kill).
req() {
  kubectl -n "$ns" exec "$pod" -c example-fastapi -- python -c \
    'import sys, urllib.request; print(urllib.request.urlopen(sys.argv[1], timeout=30).read().decode())' \
    "http://127.0.0.1:8000$1"
}

# working_set: the container's memory.current minus inactive file cache.
working_set() {
  kubectl -n "$ns" exec "$pod" -c example-fastapi -- python -c '
cur = int(open("/sys/fs/cgroup/memory.current").read())
stat = dict(line.split() for line in open("/sys/fs/cgroup/memory.stat"))
print(cur - int(stat.get("inactive_file", 0)))'
}

# The open instances of this pod's current container that sent resources.
live_instances() {
  # shellcheck disable=SC2016 # $1 does expand: the quotes are part of the SQL.
  psql_q "SELECT count(*) FROM app_instances
          WHERE environment = '$env_name' AND pod_uid = '$uid' AND ended_at IS NULL
            AND resources IS NOT NULL ${1:+AND container_id <> '$1'}"
}
have_workers() { [ "$(live_instances "${1:-}")" -ge 2 ]; }

app_id=""
container_of_pod() {
  psql_q "SELECT container_id FROM app_instances
          WHERE environment = '$env_name' AND pod_uid = '$uid' AND ended_at IS NULL AND container_id <> ''
          ORDER BY last_seen_at DESC LIMIT 1"
}

events_for() { # events_for <container_id> -> kinds, comma separated
  psql_q "SELECT coalesce(string_agg(DISTINCT kind, ',' ORDER BY kind), '') FROM app_instance_events
          WHERE environment = '$env_name' AND container_id = '$1'"
}

# ------------------------------------------------- 2. identity and limits
log "identity, limits and one container figure"
wait_until 240 "both workers sent a heartbeat with resources" have_workers ||
  die "no two workers with resources within 240 s"
app_id="$(psql_q "SELECT app_id FROM app_instances WHERE environment = '$env_name' LIMIT 1")"
node_name="$(pod_json '{.items[0].spec.nodeName}')"
cid1="$(container_of_pod)"

row="$(psql_q "
  SELECT count(*),
         count(*) FILTER (WHERE container_id <> ''),
         count(*) FILTER (WHERE pod_name = '$pod' AND namespace = '$ns' AND node_name = '$node_name'
                          AND platform = 'k8s' AND NOT hostname_guess AND process_start_time IS NOT NULL),
         count(DISTINCT container_id),
         count(*) FILTER (WHERE resources ->> 'limit_source' = 'cgroup_v2'),
         count(*) FILTER (WHERE (resources -> 'metrics' ->> 'container.cpu.limit_cores')::float8 = 0.5),
         count(*) FILTER (WHERE (resources -> 'metrics' ->> 'container.memory.limit')::float8 = $limit),
         round((max((resources -> 'metrics' ->> 'container.memory.current.avg')::float8)
               / nullif(min((resources -> 'metrics' ->> 'container.memory.current.avg')::float8), 0))::numeric, 3),
         max((resources -> 'metrics' ->> 'container.memory.current.max')::float8) <= $limit,
         round((sum((resources -> 'metrics' ->> 'process.memory.rss.avg')::float8) / 1048576)::numeric),
         round((max((resources -> 'metrics' ->> 'container.memory.current.avg')::float8) / 1048576)::numeric)
  FROM app_instances
  WHERE environment = '$env_name' AND pod_uid = '$uid' AND ended_at IS NULL AND resources IS NOT NULL")"
IFS='|' read -r n n_cid n_ident n_containers n_source n_cpu n_mem spread within rss_sum_mib container_mib <<<"$row"
# Restart and OOM inference keys on the container id. containerd on cgroup v2
# hides it from /proc/self/cgroup (private cgroup namespace); the SDKs then
# look for a containers/<id>/ bind mount in mountinfo.
if [ "$n_cid" != "$n" ]; then
  bad "only $n_cid of $n workers found their container id (cgroup: $(kubectl -n "$ns" exec "$pod" -- cat /proc/self/cgroup 2>/dev/null))"
  die "no container id: the OOM-kill and restart steps cannot be inferred"
fi
expect "$n workers carry pod name/uid, namespace, node, platform k8s" \
  "identity: $n_ident of $n workers have every identity field" [ "$n_ident" = "$n" ]
expect "the workers share one container_id ($cid1)" "workers report $n_containers container ids" \
  [ "$n_containers" = "1" ]
expect "limit_source cgroup_v2" "limit_source cgroup_v2 on $n_source of $n" [ "$n_source" = "$n" ]
expect "CPU limit 0.5 core" "CPU limit 0.5 on $n_cpu of $n" [ "$n_cpu" = "$n" ]
expect "memory limit 256 MiB" "memory limit 256 MiB on $n_mem of $n" [ "$n_mem" = "$n" ]
if [ "$within" = "t" ] && awk -v s="${spread:-9}" 'BEGIN { exit !(s <= 1.5) }'; then
  ok "container memory is one figure: ${container_mib} MiB on every worker (max/min $spread), within the limit; the workers' RSS adds up to ${rss_sum_mib} MiB"
else
  bad "container memory differs across workers (max/min $spread) or exceeds the limit ($within)"
fi

# ------------------------------------------------------------ 3. OOM kill
log "OOM kill"
target=$((limit * 92 / 100))
for _ in $(seq 1 40); do
  ws="$(working_set)"
  [ "$ws" -ge "$target" ] && break
  req "/leak?mb=8" >/dev/null
done
printf '  ...  working set %s MiB of 256 MiB\n' "$(($(working_set) / 1048576))"
stored_high() {
  [ "$(psql_q "SELECT count(*) FILTER (WHERE coalesce(
                  (resources -> 'metrics' ->> 'container.memory.working_set.max')::float8,
                  (resources -> 'metrics' ->> 'container.memory.current.max')::float8, 0) >= 0.9 * $limit)
               = count(*) AND count(*) > 0
             FROM app_instances
             WHERE environment = '$env_name' AND container_id = '$cid1' AND ended_at IS NULL")" = "t" ]
}
wait_until 150 "every worker's last heartbeat saw >= 90 % of the limit" stored_high ||
  warn "no heartbeat stored >= 90 % before the kill; the end may read restart"
before="$(restarts)"
for _ in $(seq 1 20); do
  req "/leak?mb=32" >/dev/null 2>&1 || true
  [ "$(restarts)" -gt "$before" ] && break
  sleep 1
done
wait_until 120 "the container restarted" restarted_since "$before" ||
  die "the container was not restarted after leaking past the limit"
reason="$(kubectl -n "$ns" get pod "$pod" -o 'jsonpath={.status.containerStatuses[0].lastState.terminated.reason}')"
expect "the kubelet reports OOMKilled" "last termination reason $reason, want OOMKilled" [ "$reason" = "OOMKilled" ]
kubectl -n "$ns" wait --for=condition=Ready "pod/$pod" --timeout 180s >/dev/null
wait_until 240 "the new container's workers reported" have_workers "$cid1" ||
  die "the restarted container sent no heartbeats with resources"
oom_ended() { case ",$(events_for "$cid1")," in *,oom,* | *,suspected_oom,*) return 0 ;; *) return 1 ;; esac; }
# A dead worker of a live container is ended after 150 s; a whole-container
# kill (cgroup v2 memory.oom.group) on the new container's first heartbeat.
if wait_until 240 "an oom / suspected_oom event for $cid1" oom_ended; then
  ok "OOM kill recorded: events $(events_for "$cid1")"
else
  bad "no oom or suspected_oom event for the OOM-killed container (events: $(events_for "$cid1"))"
fi
ended="$(psql_q "SELECT string_agg(DISTINCT ended_reason, ',') FROM app_instances
                 WHERE environment = '$env_name' AND container_id = '$cid1'")"
case ",$ended," in
  *,oom,* | *,suspected_oom,*) ok "the killed workers ended as $ended" ;;
  *) bad "the killed workers ended as '$ended', want oom or suspected_oom" ;;
esac

# ------------------------------------------------------------- 4. restart
log "restart (SIGKILL through the CRI)"
cid2="$(container_of_pod)"
before="$(restarts)"
ctr="$(docker exec "$node" crictl ps --name example-fastapi -q | head -n 1)"
[ -n "$ctr" ] || die "crictl found no example-fastapi container on $node"
docker exec "$node" crictl stop --timeout 0 "$ctr" >/dev/null
wait_until 120 "the container restarted" restarted_since "$before" ||
  die "the container was not restarted after the kill"
kubectl -n "$ns" wait --for=condition=Ready "pod/$pod" --timeout 180s >/dev/null
wait_until 240 "the third container's workers reported" have_workers "$cid2" ||
  die "the restarted container sent no heartbeats with resources"
restart_ended() { case ",$(events_for "$cid2")," in *,restart,*) return 0 ;; *) return 1 ;; esac; }
if wait_until 240 "a restart event for $cid2" restart_ended; then
  ok "restart recorded: events $(events_for "$cid2")"
else
  bad "no restart event for the killed container (events: $(events_for "$cid2"))"
fi

# --------------------------------------------------------- 5. delete pod
log "kubectl delete pod"
cid3="$(container_of_pod)"
old_uid="$uid"
kubectl -n "$ns" delete pod "$pod" --wait=true --timeout 120s >/dev/null
kubectl -n "$ns" rollout status deploy/example-fastapi --timeout 240s >/dev/null
pod="$(pod_json '{.items[0].metadata.name}')"
uid="$(pod_json '{.items[0].metadata.uid}')"
[ "$uid" != "$old_uid" ] || die "the replacement pod has the old pod uid"
wait_until 240 "the replacement pod's workers reported" have_workers ||
  die "the replacement pod sent no heartbeats with resources"
graceful="$(psql_q "SELECT count(*) FILTER (WHERE ended_reason = 'graceful') || '/' || count(*)
                    FROM app_instances WHERE environment = '$env_name' AND container_id = '$cid3'")"
case "$graceful" in
  0/*) bad "none of the deleted pod's workers sent a final heartbeat ($graceful graceful)" ;;
  *) ok "the deleted pod's workers ended graceful ($graceful)" ;;
esac
expect "no restart is inferred across pods" "a deleted pod produced events: $(events_for "$cid3")" \
  [ -z "$(events_for "$cid3")" ]

# --------------------------------------------------- query API, when served
if [ -n "$read_key" ] && [ -n "$app_id" ]; then
  events_json="$(mktemp)"
  code="$(curl -s -o "$events_json" -w '%{http_code}' -H "Authorization: Bearer $read_key" \
    "$api/api/v1/apps/$app_id/instance-events?environment=$env_name&range=1h" || true)"
  if [ "$code" = "200" ]; then
    expect "the instance-events API lists the restart" "the instance-events API does not list restart" \
      grep -q '"restart"' "$events_json"
    expect "the instance-events API lists the OOM kill" "the instance-events API does not list oom / suspected_oom" \
      grep -Eq '"(oom|suspected_oom)"' "$events_json"
  else
    warn "GET /api/v1/apps/{id}/instance-events answered $code; asserted through Postgres only"
  fi
fi

if [ "$failures" -gt 0 ]; then
  dump
  echo "$failures drill check(s) failed" >&2
  exit 1
fi
echo
echo "kind drill passed (environment $env_name)"
