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
| `GET /outbound` | outbound HTTP call (FastAPI → Express → Spring → FastAPI `/orders/7`) |

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

## e2e

With the apps up, `test/e2e` checks that each SDK's captures reach ClickHouse:

```bash
APILENS_E2E_EXAMPLES=http://127.0.0.1:18001,http://127.0.0.1:18002,http://127.0.0.1:18003 \
  task test:e2e -- -run TestExampleApps
```

(plus the usual `APILENS_E2E_*` variables, see `test/e2e/ingest_e2e_test.go`).
