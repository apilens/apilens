# 0010 — Runtime resources: in-process sampling, shipped in the heartbeat

**Context.** APILens shows what an API does, not what the process serving it costs. No SDK collects CPU, memory or runtime health. The heartbeat (`POST /v1/heartbeat`) overwrites one Postgres row per instance, so there is no history, and request rows carry no instance id, so latency cannot be split per instance. Competitors only partly cover this:
- Apitally shows CPU% and RSS per environment, with no container limits, runtime internals or per-instance view.
- Datadog and Sentry merge forked workers by default.
- New Relic misses OOMKills when its kubelet poll does not land.

Milestone M7 adds runtime resources. The decisions are fixed in issue #1080 (D1–D15); this ADR records the architecture.

**Decision (M7).**
- **Collected in the SDK process, sent in the heartbeat.** Each SDK samples every 15 s and adds a `resources` block (min/avg/max/last per gauge, deltas for counters) and an `identity` block to the heartbeat it already sends about once a minute. This needs no new endpoint, connection or rate limit. OTLP metrics ingest is deferred.
- **Versioned contract with real nulls.**
  - `resources.v = 1`.
  - A value that could not be measured is absent or null, never 0.
  - Every process states `capabilities` and `limit_source`, so the UI can explain its numbers.
  - The golden fixtures in `testdata/resources/` pin the shape for the edge and all three SDKs.
- **Two scopes.**
  - `process` is the SDK process; `container` is its cgroup.
  - Every worker of a container reports the same container numbers, and the server keeps one series per `container_id`.
  - Worker RSS or PSS is never summed to get container memory, because shared copy-on-write pages would be counted once per worker.
- **CPU is reported two ways.** `cores_used` is absolute; `pct_of_limit` is against the effective limit (cgroup quota, CPU affinity or cpuset, else host cores). Throttling is a first-class signal, because CPU can look low on average while p99 latency suffers.
- **Storage.**
  - ClickHouse `app_instance_resources`: one row per process per heartbeat, retention signal `resources` (default 30 days), and an hourly rollup `app_instance_resources_1h` (`resources_1h`, 400 days).
  - Numeric values go in a `Map(LowCardinality(String), Float64)` keyed by dotted metric names (`container.memory.working_set.max`). A missing key means "not measured", new metrics need no migration, and `sumMap`/`minMap`/`maxMap` roll it up.
  - Postgres `app_instances` keeps the identity and the latest snapshot for the instances list.
- **Restarts and OOMKills are inferred at the edge.** A process killed by the OOM killer cannot report. The next process in the same container can. When a new instance appears for the same container identity, the previous one is closed, with the reason in this order of precedence:
  1. `graceful`: its final heartbeat was seen.
  2. `oom`: a cgroup `oom_kill` delta was seen.
  3. `suspected_oom`: its last working set was at least 90 % of the limit.
  4. `restart`: anything else.

  This does not depend on kubelet polling.
- **Per-instance request metrics.** Request records carry `instance_id`, so per-instance latency and throughput can sit next to resources.
- **Safety and privacy.**
  - The sampler budget is under 0.1 % of a core, and the SDK measures its own cost.
  - Every collector is isolated, so a failing reader is switched off and never crashes the app.
  - The local kill switch `capture_resources` defaults to on, and the remote policy can only narrow it.
  - The process list holds pid, ppid, `comm`, CPU and RSS of processes in the SDK's own cgroup, and never argv or environment. The edge drops anything else.

**Consequences.**
- Resource history is about one row per process per minute. That is small next to `api_requests` (200 pods × 4 workers ≈ 1.15 M rows a day).
- The Map column trades column-level types for flexibility. Queries read `if(mapContains(metrics, k), metrics[k], NULL)` so a missing metric stays null.
- Anything the heartbeat cannot see is out of scope: whole-host metrics, other containers' processes, disk and network. That remains the job of node-exporter or the OTel Collector `hostmetrics` receiver.
