# SDK overhead on the example apps

What the APILens middleware costs a real app, per SDK and capture posture.
The harness is [`tools/appbench`](../../tools/appbench); the targets are the
three example apps in [`examples/`](../../examples) (FastAPI + Python SDK,
Express + TypeScript SDK, Spring Boot + Java SDK).

## Method

- **Postures.** Every app runs four times: `off` (the middleware is not
  installed at all, the baseline), then the SDK capture profiles `metadata`,
  `redacted` and `full` (`EXAMPLE_POSTURE`, see `examples/README.md`).
- **Load.** `POST /orders` with a valid JSON order body of exactly **1 KB**
  and **32 KB** (the padding is in `item`, which every app echoes, so the
  response grows too; the body carries an email and a card number so
  `redacted` has fields to mask). Each row is 5 s of warm-up and 20 s timed at
  a fixed **200 req/s** (open loop, up to 8 connections), so every posture
  sees the same load. A request counts only if it answers 201.
- **Added latency** is the posture's p50/p95 minus the `off` row of the same
  app and body size, measured at the client, so it includes everything the
  middleware does on the request path (record building, masking, enqueueing)
  but not the background flush, except where it competes for CPU.
- **Memory** is read once per app after its load: the container's memory
  usage from `docker stats` in compose (what the 512 MiB limit counts), or
  the process RSS from `ps` for apps run on the host. It is one value per app
  and posture (both body sizes ran by then). Managed runtimes grow their heap
  lazily, so treat it as an upper bound on what the SDK keeps alive.

## Soft thresholds

Annotated (a `::warning::` in the nightly run), not failing:

| Check | Limit |
|---|---|
| Added p50 at 1 KB | ≤ 1 ms |
| Added p95, every size | ≤ 5 ms |
| Added memory | ≤ 128 MiB |
| Non-201 responses | none |
| Requests the app could not take at the target rate | ≤ 1 % |

`appbench report -fail-on-threshold` makes them blocking; the flags
`-max-added-p50`, `-max-added-p95` and `-max-added-memory` change the limits.
The in-process Python benchmark (`packages/sdk-python/benchmarks/overhead.py`,
`sdk-python-bench.yml`) keeps the tighter 0.5 ms p50 budget for the Python
middleware alone, without network or server noise.

## Where the numbers come from

- **Nightly:** [`examples-bench.yml`](../../.github/workflows/examples-bench.yml)
  runs the whole loop on `ubuntu-24.04` against the compose stack (apps
  sending to the real ingest edge) and uploads `overhead.md` and
  `overhead.json` as the `examples-overhead` artifact; the table is also in the
  job summary.
- **Locally:**

  ```sh
  task examples:up        # e2e stack + the three apps, keys in examples/.env
  task bench:examples     # writes bin/appbench/{off,metadata,redacted,full}.json, overhead.md
  APPBENCH_RUN_ARGS="-duration 60s -rate 500" task bench:examples   # longer, heavier
  ```

  `appbench run -target name=url -pid name=<pid>` also measures an app you
  started yourself; `appbench report` joins any set of per-posture files that
  includes an `off` baseline for each app.

## First run (2026-11-05)

The three apps run directly on a developer laptop (Apple M4 Pro, 12 cores;
Python 3.12 + uvicorn, Node 22, Java 21 with `-Xmx384m`), each SDK sending to
a local stub ingest that answers 200, while other workloads shared the
machine. It shows the shape, not CI-grade numbers: added latency within
±0.1 ms is noise (some rows are negative), and the nightly run supersedes
this table.

`POST /orders` at a fixed 200 req/s over up to 8 connections, 20 s timed per
row after 3 s (8 s for Spring) of warm-up.

| App | Body | Posture | p50 | p95 | p99 | Added p50 | Added p95 | req/s | Memory | Added memory | Soft thresholds |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| fastapi | 1 KB | off | 0.53 ms | 0.91 ms | 1.47 ms | — | — | 200 | 55 MiB | — | baseline |
| fastapi | 1 KB | metadata | 0.61 ms | 0.96 ms | 1.54 ms | +0.08 ms | +0.04 ms | 200 | 86 MiB | +32 MiB | ok |
| fastapi | 1 KB | redacted | 0.59 ms | 0.99 ms | 1.61 ms | +0.06 ms | +0.07 ms | 200 | 119 MiB | +65 MiB | ok |
| fastapi | 1 KB | full | 0.60 ms | 0.97 ms | 1.58 ms | +0.07 ms | +0.06 ms | 200 | 107 MiB | +52 MiB | ok |
| fastapi | 32 KB | off | 0.51 ms | 0.76 ms | 0.93 ms | — | — | 200 | 55 MiB | — | baseline |
| fastapi | 32 KB | metadata | 0.69 ms | 1.07 ms | 1.69 ms | +0.18 ms | +0.32 ms | 200 | 86 MiB | +32 MiB | ok |
| fastapi | 32 KB | redacted | 0.57 ms | 0.98 ms | 2.86 ms | +0.06 ms | +0.22 ms | 200 | 119 MiB | +65 MiB | ok |
| fastapi | 32 KB | full | 0.54 ms | 0.83 ms | 4.65 ms | +0.03 ms | +0.07 ms | 200 | 107 MiB | +52 MiB | ok |
| express | 1 KB | off | 0.25 ms | 0.64 ms | 1.15 ms | — | — | 200 | 109 MiB | — | baseline |
| express | 1 KB | metadata | 0.39 ms | 0.77 ms | 1.10 ms | +0.13 ms | +0.13 ms | 200 | 133 MiB | +24 MiB | ok |
| express | 1 KB | redacted | 0.31 ms | 0.66 ms | 1.19 ms | +0.05 ms | +0.01 ms | 200 | 174 MiB | +65 MiB | ok |
| express | 1 KB | full | 0.31 ms | 0.69 ms | 1.11 ms | +0.05 ms | +0.05 ms | 200 | 142 MiB | +33 MiB | ok |
| express | 32 KB | off | 0.37 ms | 0.89 ms | 1.19 ms | — | — | 200 | 109 MiB | — | baseline |
| express | 32 KB | metadata | 0.44 ms | 0.79 ms | 1.21 ms | +0.07 ms | -0.10 ms | 200 | 133 MiB | +24 MiB | ok |
| express | 32 KB | redacted | 0.42 ms | 1.91 ms | 11.24 ms | +0.05 ms | +1.01 ms | 199 | 174 MiB | +65 MiB | ok |
| express | 32 KB | full | 0.40 ms | 0.79 ms | 2.56 ms | +0.02 ms | -0.11 ms | 200 | 142 MiB | +33 MiB | ok |
| spring | 1 KB | off | 0.28 ms | 2.28 ms | 6.49 ms | — | — | 200 | 234 MiB | — | baseline |
| spring | 1 KB | metadata | 0.29 ms | 0.65 ms | 1.10 ms | +0.02 ms | -1.63 ms | 200 | 358 MiB | +124 MiB | ok |
| spring | 1 KB | redacted | 0.27 ms | 0.65 ms | 1.13 ms | -0.01 ms | -1.64 ms | 200 | 398 MiB | +164 MiB | **over:** added memory 164 MiB > 128 MiB |
| spring | 1 KB | full | 0.26 ms | 0.80 ms | 1.30 ms | -0.02 ms | -1.48 ms | 200 | 325 MiB | +90 MiB | ok |
| spring | 32 KB | off | 0.32 ms | 1.02 ms | 1.73 ms | — | — | 200 | 234 MiB | — | baseline |
| spring | 32 KB | metadata | 0.31 ms | 0.76 ms | 1.00 ms | -0.01 ms | -0.27 ms | 200 | 358 MiB | +124 MiB | ok |
| spring | 32 KB | redacted | 0.32 ms | 0.59 ms | 1.19 ms | -0.01 ms | -0.43 ms | 200 | 398 MiB | +164 MiB | **over:** added memory 164 MiB > 128 MiB |
| spring | 32 KB | full | 0.41 ms | 0.93 ms | 1.55 ms | +0.09 ms | -0.09 ms | 200 | 325 MiB | +90 MiB | ok |

## Reading the numbers

- On the request path the middleware costs well under the 1 ms budget for
  every SDK and posture: the median added latency is below 0.2 ms, and the
  p95 differences are mostly within run-to-run noise (the Spring `off`
  baseline's p95 was the slowest of its rows, which is JIT warm-up rather
  than anything the SDK saves).
- Memory is where the postures differ. `redacted` and `full` capture headers
  and request/response bodies (capped at 16 KB and 64 KB) and hold them until
  the batch is sent, so they keep more alive than `metadata`. The Spring rows breach the soft 128 MiB limit, but that is
  the JVM committing heap up to `-Xmx` under allocation pressure, not live
  data; compare the nightly container numbers before acting on it.
- An earlier local pass on the same machine, under heavier load from other
  processes, showed one 80 ms p95 stall (FastAPI, `full`, 1 KB) that did not
  reproduce. That is why the thresholds are soft and the nightly run, not one
  laptop pass, is the reference.
