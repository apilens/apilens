# Example apps

Three small APIs instrumented with the SDKs from this repo, used as realistic
targets by the e2e, failure-drill and benchmark tasks.

| App | SDK | Port (host) | App slug |
| --- | --- | --- | --- |
| [`fastapi/`](fastapi) | `packages/sdk-python` | 18001 | `example-fastapi` |
| [`express/`](express) | `packages/sdk-typescript` | 18002 | `example-express` |
| [`spring/`](spring) | `packages/sdk-java` | 18003 | `example-spring` |

Every app serves the same endpoints:

| Endpoint | What it exercises |
| --- | --- |
| `GET /health` | liveness; dropped by the SDKs' default exclusions |
| `GET /orders/{id}` | JSON response, templated path |
| `POST /orders` | JSON body (`item`, `quantity`, `email`, `card_number`); 201, or 422 with validation errors |
| `POST /login` | `application/x-www-form-urlencoded` body (`username`, `password`) |
| `POST /upload` | `multipart/form-data` (`file`, `description`) |
| `GET /boom` | unhandled exception, 500 |
| `GET /boom/chained` | unhandled exception with a 3-level cause chain (Python `raise ... from`, JS `Error.cause`, Java `getCause`), 500 |
| `GET /boom/deep` | unhandled exception raised 60 frames deep (recursion), 500 |
| `GET /boom/handled` | exception the framework's own handler turns into a 500 (FastAPI `exception_handler`, Express error middleware, Spring `@ControllerAdvice`) |
| `GET /boom/logged` | exception (3-level chain) caught and logged (`logger.exception`, `console.error` plus `captureException`, SLF4J `log.error`), 200 |
| `GET /outbound` | outbound HTTP call (FastAPI → Express → Spring → FastAPI `/orders/7`) |
| `GET /leak?mb=N` | keeps N MiB (default 16, 1–64 per call, else 422) allocated in the process for good: memory charts, OOM kills |
| `GET /burn?ms=N` | spins one core for N ms (default 200, 1–5000, else 422): CPU and throttling |

## Run

```bash
task examples:up      # e2e stack + seeded apps/key (examples/.env) + the three apps
task examples:smoke   # hit every endpoint once, check status codes
task examples:down    # stop the apps (task e2e:down stops the stack)
```

The apps run under the compose profile `examples`
([`deploy/compose/compose.examples.yaml`](../deploy/compose/compose.examples.yaml)),
layered on the CI stack, and send to `http://apilens:8080/v1`.

## Posture and options

Set these in the environment of `task examples:up` (or `docker compose`):

| Variable | Default | Effect |
| --- | --- | --- |
| `APILENS_EXAMPLES_POSTURE` | `full` | `metadata`, `redacted` or `full` picks the SDK capture profile; `off` runs the apps without the SDK (benchmark baseline) |
| `APILENS_EXAMPLES_SAMPLE_RATE` | `1.0` | `APILENS_SAMPLE_RATE` for every SDK |
| `APILENS_EXAMPLES_REDACT_BODY_FIELDS`, `_REDACT_HEADERS`, `_REDACT_QUERY_PARAMS` | empty | extra masking regexes |
| `APILENS_EXAMPLES_EXCLUDE_PATHS` | empty | extra excluded path regexes |
| `APILENS_EXAMPLES_ENVIRONMENT` | `production` | environment name |
| `APILENS_EXAMPLES_INGEST_URL` | `http://apilens:8080/v1` | SDK base URL |
| `APILENS_EXAMPLES_{FASTAPI,EXPRESS,SPRING}_PORT` | 18001-18003 | host ports |

```bash
APILENS_EXAMPLES_POSTURE=metadata task examples:up
```

Inside each container the app reads `EXAMPLE_POSTURE` and the SDK reads the
usual `APILENS_*` variables, so the same apps run outside compose too, e.g.
`EXAMPLE_POSTURE=redacted APILENS_API_KEY=... APILENS_APP_ID=example-fastapi uvicorn main:app`.

## Resource limits (runtime resources)

`APILENS_EXAMPLES_LIMITS=1` layers
[`compose.examples.limits.yaml`](../deploy/compose/compose.examples.limits.yaml):
every app gets `cpus: 0.5` and `mem_limit: 256m`, and runs the way production
APIs fork workers.

| App | Process model |
| --- | --- |
| FastAPI | `gunicorn --preload -w 4` with uvicorn workers: 4 SDK instances forked from one master |
| Express | `node cluster.mjs`: a `node:cluster` primary (no SDK) and 2 workers |
| Spring | one JVM, `-XX:MaxRAMPercentage=50`; past the heap, `/leak` exits the JVM (`ExitOnOutOfMemoryError`) and Docker restarts it |

```bash
APILENS_EXAMPLES_LIMITS=1 task examples:up
APILENS_SMOKE_RESOURCES=1 task examples:smoke
```

With `APILENS_SMOKE_RESOURCES=1` the smoke test also reads ClickHouse
`app_instance_resources` and checks that every heartbeat says
`limit_source = cgroup_v2` with a 0.5-core and a 256 MiB limit, that the
workers are separate instances sharing one `container_id`, and that their
container memory is one figure for the container (the same on every worker,
never above the limit) rather than four workers' RSS added up. CI runs this
as the `resources-smoke` job of `.github/workflows/examples-bench.yml`.

`test/kind/drill.sh` (`task test:kind:drill`) runs the FastAPI app on a kind
cluster and drives `/leak` into an OOM kill, see the
[Kubernetes guide](../apps/docs/guides/kubernetes.mdx).

## e2e

With the apps up, `test/e2e` checks that each SDK's captures reach ClickHouse:

```bash
APILENS_E2E_EXAMPLES=http://127.0.0.1:18001,http://127.0.0.1:18002,http://127.0.0.1:18003 \
  task test:e2e -- -run TestExampleApps
```

(plus the usual `APILENS_E2E_*` variables, see `test/e2e/ingest_e2e_test.go`).

`task test:e2e:privacy` proves masked fields never reach ClickHouse through
all three SDKs. It seeds a query parameter, a header and top-level and nested
JSON body fields named `e2e_pii` through every app twice: first with the SDK
masking patterns set (`APILENS_EXAMPLES_REDACT_*`) and no server-side policy,
then with the client patterns deliberately missing and the project's
server-side privacy policy naming them. Each run requires `[redacted]` in
every row and fails on any seeded value found in any column of
`api_requests`, `api_logs` or `api_spans`.

`task test:e2e:drills` runs the failure drills (also nightly in CI,
`.github/workflows/e2e-drills.yml`). The apps send to a fault proxy the test
runs on the host (`APILENS_EXAMPLES_INGEST_URL=http://host.docker.internal:18090/v1`),
which forwards to the edge until each drill takes ingest down (connections
refused), answers 503, or answers 429 with `Retry-After: 2` for 25 s while
every app keeps serving traffic. Each drill requires the apps to keep
answering 200 with p99 latency within 2x (or +100 ms) of the baseline, the
SDK stats in the heartbeats (`/api/v1/apps/{id}/status`) to count every lost
request as a drop (`retries_exhausted`), retries after a 429 to wait
`Retry-After`, and everything sent around the fault to arrive exactly once.
