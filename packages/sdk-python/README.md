# API Lens — Python SDK

[![PyPI version](https://img.shields.io/pypi/v/apilenss.svg)](https://pypi.org/project/apilenss/)
[![Python versions](https://img.shields.io/pypi/pyversions/apilenss.svg)](https://pypi.org/project/apilenss/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Drop-in observability for Python HTTP services. Add one middleware and API Lens
captures every request — endpoint, latency, status, payloads — attributes it to
the consumer who made it, and stitches it into a distributed trace, then streams
it to your dashboard from a background thread that never blocks your request path.

```python
from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware

app = FastAPI()
app.add_middleware(ApiLensMiddleware, api_key="apilens_xxx", app_id="orders-api")
```

That is the whole setup. No agent, no sidecar, no code changes to your handlers.

---

## Table of contents

- [Install](#install)
- [The two values you need](#the-two-values-you-need)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Framework integrations](#framework-integrations)
  - [FastAPI](#fastapi) · [Django](#django) · [Flask](#flask) · [Starlette](#starlette) · [Other ASGI apps](#other-asgi-apps)
- [Consumer attribution](#consumer-attribution)
- [Distributed tracing](#distributed-tracing)
- [Configuration reference](#configuration-reference)
- [Manual capture](#manual-capture)
- [Reliability & performance](#reliability--performance)
- [SDK health & stats](#sdk-health--stats)
- [Deployment shapes](#deployment-shapes)
- [Security & privacy](#security--privacy)
- [Network requirements](#network-requirements)
- [OpenTelemetry interoperability](#opentelemetry-interoperability)
- [Troubleshooting](#troubleshooting)
- [Support](#support)

---

## Install

The distribution is `apilenss`; the import package is `apilens`.

```bash
pip install apilenss
```

Framework extras pull in the matching web framework if you don't already depend on it:

```bash
pip install 'apilenss[fastapi]'     # or [flask] / [django] / [starlette] / [litestar] / [blacksheep]
pip install 'apilenss[all]'         # everything
```

Requires Python 3.10+. The only hard dependencies are `opentelemetry-api` and
`opentelemetry-sdk`.

---

## The two values you need

| Value | What it is | Where to find it |
|-------|-----------|------------------|
| `api_key` | **Project-level** key. One key works for every app in the project — the server derives the project from the key. | Project → API keys, in the [dashboard](https://app.apilens.ai). |
| `app_id` | The slug of the specific app (service) you're instrumenting, so traffic is attributed to the right app. | The app's page in the dashboard. |

`project_slug` is **optional** — you only pass it if you want the SDK to assert
the key belongs to a specific project. `base_url` defaults to
`https://ingest.apilens.ai/v1`.

> Keep the API key out of source. Read it from the environment (`APILENS_API_KEY`)
> or your secrets manager.

---

## Quick start

```python
import os
from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware

app = FastAPI()

app.add_middleware(
    ApiLensMiddleware,
    api_key=os.environ["APILENS_API_KEY"],
    app_id="orders-api",
)
```

Deploy, send traffic, and requests appear in the dashboard within a few seconds.
From here you'll typically add [consumer attribution](#consumer-attribution) (who
called each endpoint) and lean on the automatic [distributed tracing](#distributed-tracing).

---

## How it works

```
┌─────────────────────────────────────────┐
│ your process                             │
│                                          │
│  request ─▶ ApiLens middleware ─▶ handler│
│                    │                     │
│            captures a record             │
│                    ▼                     │
│            in-memory queue  ──┐          │
└───────────────────────────────┼─────────┘
                                 │  background daemon thread
                                 ▼  (batch of 200, or every 3s)
                    POST /requests  ·  POST /traces
                                 ▼
                        API Lens ingest ─▶ dashboard
```

1. **Capture is synchronous but trivial.** The middleware wraps the request,
   records method, path, status, latency, byte sizes, client IP, user-agent,
   consumer identity, and (optionally) payloads/headers, then hands the finished
   record to an in-memory queue. It does not touch the network on the request path.
2. **Delivery is asynchronous.** A background daemon thread drains the queue in
   batches (default 200 records, or every 3 seconds, whichever comes first) and
   POSTs them to the ingest endpoint with retries and exponential backoff.
3. **It fails safe.** If the ingest endpoint is unreachable the queue absorbs the
   backlog up to `max_queue_size` (default 10,000) records and `max_queue_bytes`
   (default 64 MB) and drops the **oldest** records once either is reached — your app keeps serving traffic regardless. Nothing the SDK
   does can raise into your handler.
4. **Requests and spans share the pipeline.** Request records go to `/requests`;
   [trace spans](#distributed-tracing) go to `/traces` on the same batching client.

The framework integrations flush the queue on graceful shutdown (ASGI lifespan
or `atexit`, bounded by `shutdown_timeout`); see
[Deployment shapes](#deployment-shapes). With a bare client, call
`client.shutdown(flush=True)` yourself.

---

## Endpoint grouping (path templating)

`GET /product/123` and `GET /product/324` are the **same endpoint**, so the SDK
groups them under the route template `GET /product/{id}` instead of exploding
into one endpoint per id. It does this the accurate way — by reading the
**matched route** from your framework:

| Framework | Source of the template |
| --- | --- |
| FastAPI / Starlette | matched `route.path` |
| Flask | `url_map` rule (`/product/<int:id>` → `/product/{id}`) |
| Django / django-ninja | `resolver_match.route` |
| Litestar | route handler path |
| BlackSheep | matched route pattern |

The **exact URL** (`/product/123`) is preserved separately and shown in the
request log — you lose nothing.

When no route matches (an unhandled URL, a raw ASGI app), the SDK falls back to
a conservative heuristic that parametrizes id-looking segments (integers,
UUIDs, ULIDs, long hashes) — e.g. `/product/123` → `/product/{id}`. Disable the
fallback with `parametrize_paths=False` on the middleware, or globally:

```bash
export APILENS_PARAMETRIZE_PATHS=false
```

---

## Framework integrations

| Framework | Module | Mechanism | Tracing |
|-----------|--------|-----------|:-------:|
| FastAPI | `apilens.fastapi` | ASGI middleware | ✅ |
| Starlette | `apilens.starlette` | ASGI middleware | ✅ |
| Django (DRF / Ninja) | `apilens.django` | Django middleware | ✅ |
| Flask | `apilens.flask` | WSGI middleware | ✅ |
| Litestar / BlackSheep / any ASGI | `apilens.client.middleware` | ASGI middleware | ✅ |

### FastAPI

```python
from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware

app = FastAPI()
app.add_middleware(ApiLensMiddleware, api_key="apilens_xxx", app_id="orders-api")
```

The middleware constructs and owns the client. To tune it, pass extra keywords
(`base_url`, `env`, `verify_tls`, `log_request_body`, `log_response_body`,
`max_payload_bytes`, `get_consumer`) — see the [configuration reference](#configuration-reference).

### Django

Django REST Framework and Django Ninja both work through one middleware.

```python
# settings.py
MIDDLEWARE = [
    # ... your middleware ...
    "apilens.django.ApiLensDjangoMiddleware",
]

APILENS_API_KEY = os.environ["APILENS_API_KEY"]
APILENS_APP_ID  = "orders-api"
```

All other options are optional `APILENS_*` settings (see the
[Django settings table](#django-settings)).

### Flask

```python
from flask import Flask
from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_flask

app = Flask(__name__)
client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
instrument_flask(app, client, app_id="orders-api")
```

### Starlette

```python
from starlette.applications import Starlette
from apilens import ApiLensClient, ApiLensConfig
from apilens.starlette import instrument_app

app = Starlette()
client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
instrument_app(app, client, app_id="orders-api")
```

### Other ASGI apps

**Litestar:**

```python
from litestar import Litestar
from apilens import ApiLensClient, ApiLensConfig, ApiLensPlugin

client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
app = Litestar(
    route_handlers=[...],
    plugins=[ApiLensPlugin(client=client, app_id="orders-api")],
)
```

**BlackSheep:**

```python
from blacksheep import Application
from apilens import ApiLensClient, ApiLensConfig
from apilens.blacksheep import instrument_app

client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
app = Application()
instrument_app(app, client, app_id="orders-api")
```

**Any other ASGI framework** — wrap the app with the generic middleware:

```python
from apilens import ApiLensClient, ApiLensConfig
from apilens.client.middleware import ApiLensASGIMiddleware

client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
app = ApiLensASGIMiddleware(app, client=client, app_id="orders-api")
```

---

## Consumer attribution

API Lens **never infers who the caller is.** It does not read your `Authorization`
header, decode JWTs, or inspect sessions. You attach the identity explicitly,
once your own auth has resolved it — so you decide exactly what identity (if any)
leaves your process.

Use `set_consumer(...)` (alias `track_consumer`). The `request` argument is
optional: omit it when you call from a lifecycle hook that runs before the
request object is in scope.

| Argument | Type | Notes |
|----------|------|-------|
| `identifier` | `str` | **Required.** Stable id — user id, email, API-key prefix, tenant id. |
| `name` | `str \| None` | Human-readable label shown in the dashboard. |
| `group` | `str \| None` | Team, plan tier, org, or role — used for grouping. |

**FastAPI / Starlette — dependency or per-request:**

```python
from fastapi import Depends, FastAPI, Request
from apilens.fastapi import ApiLensMiddleware, set_consumer

app = FastAPI()
app.add_middleware(ApiLensMiddleware, api_key="apilens_xxx", app_id="orders-api")

async def identify(request: Request):
    user = getattr(request.state, "user", None)   # set by YOUR auth
    if user:
        set_consumer(request, identifier=user.id, name=user.username, group=user.org)

@app.get("/orders")
async def list_orders(_: None = Depends(identify)):
    ...
```

**Flask — `before_request` (no request argument needed):**

```python
from flask import g
from apilens.flask import set_consumer

@app.before_request
def identify():
    if g.current_user:
        set_consumer(
            identifier=g.current_user["email"],
            name=g.current_user.get("name"),
            group=g.current_user.get("role"),
        )
```

**Django — centralized resolver in settings:**

```python
# settings.py
def get_consumer(request):
    if request.user.is_authenticated:
        return {
            "identifier": request.user.email,
            "name": request.user.get_full_name(),
            "group": getattr(request.user, "role", ""),
        }
    return None

APILENS_GET_CONSUMER = get_consumer          # or a dotted path: "myapp.consumers.get_consumer"
```

Or inline from a view — an explicit `set_consumer(...)` call always wins over the
resolver:

```python
from apilens.django import set_consumer

def my_view(request):
    if request.user.is_authenticated:
        set_consumer(request, identifier=request.user.email)
```

You can also pass a plain string, a dict, or your user object directly; the SDK
normalizes `id`/`identifier`, `name`/`username`, and `group`/`role` fields.

---

## Distributed tracing

Every instrumented request is automatically the root of a trace. With zero extra
code you get:

- a **root span** per request (`"GET /orders"`), timed and status-aware;
- **child spans for outbound HTTP** made with `requests` or `httpx`, with the W3C
  `traceparent` header injected so downstream services join the same trace;
- **cross-service stitching** — an inbound `traceparent` is continued, so a call
  chain across several of your services shows up as one waterfall in the dashboard.

Spans are captured **entirely automatically** — there is no manual span API.
A normal request shows its server span (plus any auto-instrumented outbound HTTP
spans) in the waterfall; nothing to wire up.

### Automatic error capture

When a request **raises an unhandled exception** or **returns a 5xx**, APILens
automatically records one ERROR message on that request's trace — with the
exception type, message, and full traceback — and marks the span as errored.
It shows up under **Trace messages** in the dashboard, lined up with the span.

```python
@app.get("/orders/{order_id}")
async def get_order(order_id: str):
    order = await db.fetch_order(order_id)   # if this raises, the trace
    return order                             # carries the exception + traceback
```

Nothing to call — a clean request has no trace messages; a failing one does.
This is the only thing written to `/v1/logs`; it is not a general logging API.

### Propagating the trace

`apilens.current_trace_id()`, `current_span_id()`, and `current_traceparent()`
return the active context (empty strings outside a request). Use
`current_traceparent()` if you propagate the trace across a boundary the SDK
doesn't patch (a message queue, a gRPC call, a manually built client).

### Turning tracing on and off

Tracing is on by default wherever an `app_id` is set. Request analytics keep
working with tracing off — you just stop emitting spans (and the outbound-HTTP
auto-instrumentation).

**Per integration** — pass `capture_spans=False`:

```python
# FastAPI
app.add_middleware(ApiLensMiddleware, api_key="apilens_xxx", app_id="orders-api", capture_spans=False)

# Flask / Starlette / Litestar / BlackSheep helpers all take capture_spans too
instrument_flask(app, client, app_id="orders-api", capture_spans=False)
```

```python
# Django — settings.py
APILENS_CAPTURE_SPANS = False
```

**Globally, without a code change** — set the environment variable (accepts
`0`/`false`/`no`/`off`). This is a kill-switch: it can only turn tracing **off**,
and it overrides any `capture_spans=True` in code, so ops can disable trace
ingestion for a whole process or fleet:

```bash
export APILENS_CAPTURE_SPANS=false
```

---

## Configuration reference

### `ApiLensConfig`

Passed to `ApiLensClient(ApiLensConfig(...))`, or expressed as keyword arguments /
`APILENS_*` settings by the framework helpers.

| Field | Default | Description |
|-------|---------|-------------|
| `api_key` | — (required) | Project-level API key. |
| `project_slug` | `""` | Optional. If set, the server validates the key belongs to it. |
| `base_url` | `https://ingest.apilens.ai/v1` | Ingest endpoint. |
| `environment` | `"production"` | Environment label (e.g. `production`, `staging`, `dev`). |
| `batch_size` | `200` | Records per POST (also the flush trigger). Backend max is 1000. |
| `max_batch_bytes` | `4 * 1024 * 1024` | Byte cap on one POST's JSON body (uncompressed). A batch is cut at `batch_size` records or `max_batch_bytes`, whichever comes first. Minimum 16 KB; keep it under the ingest edge's 16 MB limit. See [batch sizing](#reliability--performance). |
| `flush_interval` | `3.0` | Seconds between automatic flushes. |
| `timeout` | `5.0` | Per-request HTTP timeout, in seconds. |
| `max_queue_size` | `10_000` | Record cap per queue; oldest records drop once full. |
| `max_queue_bytes` | `64 * 1024 * 1024` | Memory cap shared by the request, span and log queues (estimated bytes); oldest records drop once exceeded. |
| `max_retries` | `3` | Retry attempts per batch for 408, 429, 5xx and network errors (full-jitter exponential backoff, or the server's `Retry-After`). |
| `compress` | `True` | gzip each batch (level 5, `Content-Encoding: gzip`) on the background flush thread; falls back to plain JSON if compression fails. `False` sends plain JSON. |
| `verify_tls` | `True` | Verify the ingest server's TLS certificate. |
| `ca_bundle_path` | `""` | Custom CA bundle (PEM) for TLS verification; replaces the system trust store. |
| `proxy_url` | `""` | Egress proxy for ingest traffic, e.g. `http://proxy.corp:3128` or `http://user:pass@proxy.corp:3128`. Falls back to env `APILENS_PROXY`, then `HTTPS_PROXY` / `HTTP_PROXY`. See [network requirements](#network-requirements). |
| `enabled` | `True` | Master switch; `False` disables capture and the worker entirely. |
| `on_stats` | `None` | `(ClientStats) -> None`, called on the flush thread every `flush_interval` with a stats snapshot, e.g. to export to Prometheus or StatsD. Exceptions are logged at DEBUG and ignored. See [SDK health & stats](#sdk-health--stats). |

### Middleware options

Accepted by `ApiLensASGIMiddleware` / `ApiLensWSGIMiddleware`, and by the
`ApiLensMiddleware` / `instrument_*` helpers.

| Option | Default | Description |
|--------|---------|-------------|
| `app_id` | `""` | **Required for ingestion.** Which app the traffic belongs to. |
| `environment` | client's | Override the environment label per app. |
| `capture_payloads` | `True` | Capture request/response bodies (size-limited). |
| `capture_headers` | `True` | Capture request/response headers (sensitive values redacted). |
| `log_request_body` / `log_response_body` | `True` | Toggle each body independently. |
| `max_payload_bytes` | `65536` | Per-body capture cap; set `0` to disable body capture. |
| `capture_spans` | `True` | Emit trace spans for this app. |
| `service_name` | `app_id` | Service name shown on spans. |
| `get_consumer` | `None` | Optional resolver callback (see [consumer attribution](#consumer-attribution)). |
| `mask_request_body` / `mask_response_body` | `None` | `(info, body: bytes) -> bytes \| None` callbacks on the captured (truncated) raw body; see [body mask callbacks](#security--privacy). |
| `flush_on_shutdown` | `True` | Flush the queue on ASGI lifespan shutdown / process exit (see [Deployment shapes](#deployment-shapes)). `APILENS_FLUSH_ON_SHUTDOWN=false` (env var) disables it. |
| `shutdown_timeout` | `5.0` | Upper bound, in seconds, on how long the shutdown flush may block. |
| `exclude_paths` | `None` | Regexes for paths to skip entirely (no record, span or log), e.g. `[r"^/health$"]`. Matched case-insensitively against the path without query string. `APILENS_EXCLUDE_PATHS` (comma-separated env var) adds to it. An invalid regex raises at startup. |
| `exclude_user_agents` | `None` | Regexes for `User-Agent` values to skip entirely, e.g. `[r"^uptimerobot"]`. Case-insensitive `re.search`. `APILENS_EXCLUDE_USER_AGENTS` (comma-separated env var) adds to it. |
| `default_exclusions` | `True` | Skip the [built-in health/probe exclusions](#default-exclusions) (applied before `exclude_paths`). `False` turns them off; your own `exclude_paths` / `exclude_user_agents` still apply. |
| `sample_rate` | `1.0` | Fraction (0.0–1.0) of requests whose detail — headers, bodies, spans, auto error log — is kept. See [sampling](#sampling). A value outside the range raises at startup. |

### Sampling

Sampling never changes metrics. Every request still sends its base record
(method, path, status, latency, sizes, consumer, IP, user agent, trace id), so
traffic counts, error rates and latency percentiles stay exact. With
`sample_rate=0.1`, about 90% of requests are sent with `sampled=false` and no
headers, bodies, spans or error log. Their bodies are never buffered.

`1.0` (the default) sends exactly what earlier SDK versions sent, and `0.0`
sends the base record only. A sampled-out request still continues the
caller's `traceparent` and propagates it downstream, so child services decide
independently.

### Default exclusions

Unless `default_exclusions=False` (Django: `APILENS_DEFAULT_EXCLUSIONS = False`), requests matching any of these are skipped entirely (no record, span or log), before `exclude_paths` is checked. All patterns are case-insensitive `re.search` regexes; paths are matched without the query string.

Paths (`DEFAULT_EXCLUDED_PATHS` in `apilens/client/_exclusions.py`):

```
/_?healthz?$
/_?health[\-_]?checks?$
/_?heart[\-_]?beats?$
/ping$
/ready$
/live$
/favicon(?:-[\w-]+)?\.(?:ico|png|svg)$
/apple-touch-icon(?:-[\w-]+)?\.png$
/robots\.txt$
/sitemap\.xml$
/manifest\.json$
/site\.webmanifest$
/service-worker\.js$
/sw\.js$
/\.well-known/
```

User agents (`DEFAULT_EXCLUDED_USER_AGENTS`):

```
health[\-_ ]?check
microsoft-azure-application-lb
googlehc
kube-probe
```

### Django settings

| Setting | Default | Description |
|---------|---------|-------------|
| `APILENS_API_KEY` | — (required) | Project-level API key. |
| `APILENS_APP_ID` | — (required) | App slug. |
| `APILENS_PROJECT_SLUG` | `""` | Optional project assertion. |
| `APILENS_BASE_URL` | `https://ingest.apilens.ai/v1` | Ingest endpoint. |
| `APILENS_ENVIRONMENT` | `"production"` | Environment label. |
| `APILENS_BATCH_SIZE` | `200` | Records per POST. |
| `APILENS_FLUSH_INTERVAL` | `3.0` | Seconds between flushes. |
| `APILENS_MAX_PAYLOAD_BYTES` | `65536` | Body capture cap; `0` disables bodies. |
| `APILENS_CAPTURE_HEADERS` | `True` | Capture headers (redacted). |
| `APILENS_CAPTURE_SPANS` | `True` | Emit trace spans. |
| `APILENS_SERVICE_NAME` | `APILENS_APP_ID` | Service name on spans. |
| `APILENS_GET_CONSUMER` | `None` | Consumer resolver (callable or dotted path). |
| `APILENS_MASK_REQUEST_BODY` / `APILENS_MASK_RESPONSE_BODY` | `None` | Body mask callbacks (callable or dotted path). An unimportable path raises at startup. |
| `APILENS_EXCLUDE_PATHS` | `None` | Paths to skip entirely: a list of regexes or a comma-separated string. The env var of the same name adds to it. |
| `APILENS_EXCLUDE_USER_AGENTS` | `None` | User agents to skip entirely: a list of regexes or a comma-separated string. The env var of the same name adds to it. |
| `APILENS_DEFAULT_EXCLUSIONS` | `True` | `False` turns off the [built-in health/probe exclusions](#default-exclusions). |
| `APILENS_SAMPLE_RATE` | `1.0` | Fraction of requests whose detail is kept; metrics always count every request (see [sampling](#sampling)). |
| `APILENS_FLUSH_ON_SHUTDOWN` | `True` | Flush the queue from `atexit` when the process exits. The env var of the same name set to `false` also disables it. |
| `APILENS_SHUTDOWN_TIMEOUT` | `5.0` | Upper bound, in seconds, on the shutdown flush. |

**Local development:** point the SDK at a local ingest with
`APILENS_BASE_URL=http://localhost:8000/api/v1` (or the `base_url` kwarg), and set
`verify_tls=False` if you're using a self-signed certificate.

---

## Manual capture

For non-HTTP workloads (batch jobs, workers, custom protocols) use the client
directly. It is safe to share one client across threads.

```python
from apilens import ApiLensClient, ApiLensConfig

with ApiLensClient(ApiLensConfig(api_key="apilens_xxx")) as client:
    client.capture(
        app_id="orders-api",
        method="POST",
        path="/internal/reconcile",
        status_code=200,
        response_time_ms=painstaking_ms,
    )
    # flushed on context exit
```

The context manager flushes on exit; otherwise call `client.shutdown(flush=True)`
before your process ends. `client.dropped_count` reports records shed under
backpressure and `client.drop_counts()` breaks that total down by reason (see
[Reliability & performance](#reliability--performance)).

---

## Reliability & performance

- **Non-blocking.** Capture only enqueues; all I/O happens on a background daemon
  thread. Ingest latency and outages never slow or fail your requests.
- **Bounded memory.** Queued records are capped both by count
  (`max_queue_size`, 10,000 per queue) and by size (`max_queue_bytes`, 64 MB
  shared by the request, span and log queues). Whichever limit is hit first,
  the oldest records are dropped rather than the queue growing without limit.
  A record's size is estimated as the length of its payload, header, path and
  user-agent strings (message/payload/attributes for logs and spans) plus a
  fixed 512 B overhead.

  Why both: with body capture on, a request record can carry up to
  `max_payload_bytes` (64 KB) on *each* side plus up to 8 KB of header JSON per
  side, so a count cap alone allows 10,000 × (2 × 64 KB + 2 × 8 KB + 512 B) ≈
  **1.5 GB per worker**. The byte cap holds that at 64 MB: about 450 such
  worst-case records, or ~120,000
  records without bodies (512 B + a short path each) — at that point the count
  cap binds first. Size it as `workers × max_queue_bytes` for the process
  group's worst case; lower it for many-worker deployments, raise it if you
  expect long ingest outages and have the headroom.
- **Drop accounting.** `client.dropped_count` is the total; `client.drop_counts()`
  returns it by reason:

  | Reason | Meaning |
  |---|---|
  | `queue_full` | The queue reached `max_queue_size`; the oldest record was dropped. |
  | `queue_bytes` | Queued bytes would exceed `max_queue_bytes`; the oldest record(s) were dropped (or a single record larger than the whole budget was shed). |
  | `non_retryable` | Ingest rejected the batch with a 4xx other than 408/429; it is not retried. |
  | `retries_exhausted` | The batch still failed (network, timeout, 408, 429, 5xx) after `max_retries`. |
  | `truncated` | Not a drop: one record was larger than `max_batch_bytes` on its own, so its payloads (then headers, message, attributes) were cut and marked `...[truncated]` before sending. Not counted in `dropped_count`. |
- **Size-bounded batches.** A POST is cut at `batch_size` records or
  `max_batch_bytes` (default 4 MB, measured on the uncompressed JSON, which is
  what the ingest edge limits to 16 MB), whichever comes first, so a backlog of
  large records goes out as several requests instead of one oversized body that
  ingest would reject whole. A single record over the cap is truncated rather
  than dropped. Recommended values with body capture on: **`batch_size=100`,
  `max_batch_bytes=4 * 1024 * 1024`** (100 records / 4 MB). Worst-case records
  (two 64 KB bodies plus headers, ~145 KB each) then go out about 28 per
  request, well under the edge limit and cheap to retry; typical records with
  small bodies still fill the 100-record batch. Without bodies the defaults
  (200 records / 4 MB) rarely reach the byte cap.
- **Resilient delivery.** 408, 429, 5xx, timeouts and network errors retry up to
  `max_retries` times with full-jitter exponential backoff (a random wait between
  0 and `0.25s × 2^attempt`, capped at 5s), so many workers do not retry in
  lockstep. A `Retry-After` header (seconds or HTTP date) takes precedence, capped
  at 60s. Any other 4xx drops the batch immediately and logs the response body at
  most once per status every 5 minutes; a 401 logs a single message pointing at
  [Troubleshooting](https://apilens.ai/docs/support/troubleshooting).
- **Never raises into your app.** All SDK errors are caught and logged under the
  `apilens` logger — enable it (`logging.getLogger("apilens")`) while debugging.
- **Graceful shutdown.** The framework integrations drain the queue when the
  app shuts down, never blocking longer than `shutdown_timeout`; see
  [Deployment shapes](#deployment-shapes).

---

## SDK health & stats

`client.stats()` returns a `ClientStats` snapshot of the delivery pipeline. It is
thread-safe and cheap (one short hold of the lock the capture path already uses),
so it is fine to call from a health or metrics endpoint.

| Field | Meaning |
|---|---|
| `queued_records` | Records waiting in the request, span and log queues. |
| `queued_bytes` | Estimated size of those records (bounded by `max_queue_bytes`). |
| `sent_batches` / `sent_records` | Batches and records ingest accepted (2xx), since start. |
| `failed_batches` | Batches dropped after a non-retryable 4xx or after `max_retries`. |
| `drop_counts` | Records dropped, by reason (same keys as `client.drop_counts()`). |
| `dropped` | Sum of `drop_counts`, excluding `truncated` (those were still sent). |
| `last_error` | The most recent ingest failure (including retried attempts); empty until one happens. |
| `last_success_at` | UTC `datetime` of the last accepted batch, or `None`. |

`stats.to_dict()` gives a JSON-ready form and `stats.summary()` a one-line string.

**Logging.** With the `apilens` logger at DEBUG, the flush thread logs
`API Lens stats: queued=… sent=… failed_batches=… dropped=… last_success=…` every
`flush_interval`. When records were dropped since the last report it logs the same
line at INFO instead, at most once a minute, so drops show up with default logging
without flooding it.

**Exporting.** Pass `on_stats` to push each snapshot to your metrics system. It runs
on the background flush thread every `flush_interval`; keep it quick and non-blocking.

```python
from prometheus_client import Gauge

from apilens import ApiLensClient, ApiLensConfig, ClientStats

queued = Gauge("apilens_queued_records", "Records waiting to be sent")
sent = Gauge("apilens_sent_records", "Records accepted by ingest")
failed = Gauge("apilens_failed_batches", "Batches dropped after failing")
dropped = Gauge("apilens_dropped_records", "Records dropped", ["reason"])

def export(stats: ClientStats) -> None:
    queued.set(stats.queued_records)
    sent.set(stats.sent_records)
    failed.set(stats.failed_batches)
    for reason, count in stats.drop_counts.items():
        dropped.labels(reason).set(count)

client = ApiLensClient(ApiLensConfig(api_key="...", on_stats=export))
```

With StatsD the callback is the same shape (`statsd.gauge("apilens.queued_records",
stats.queued_records)` and so on). The counters are cumulative, so export them as
gauges, or as counters by sending the difference from the previous snapshot.

**Rollout checklist.** After deploying, confirm `last_success_at` advances and
`sent_records` grows; `failed_batches` or `dropped` rising with a non-empty
`last_error` points at the cause (a 401 means a bad key; network errors mean egress
is blocked, see [Network requirements](#network-requirements)).

---

## Deployment shapes

The SDK delivers from a background thread, so whatever is still queued when a
process exits is lost unless it is flushed first. The integrations do that for
you, once per client, bounded by `shutdown_timeout` (default **5 s**) so a slow
or unreachable ingest never holds up a deploy:

| Integration | Hook | Notes |
|---|---|---|
| FastAPI / Starlette / any ASGI app | ASGI `lifespan` shutdown event | Flushes after your own shutdown handlers and before the server is told shutdown is complete. `atexit` is registered too, for servers that run with lifespan off. |
| Django (WSGI or ASGI) | `atexit` | Django has no lifespan hook. `APILENS_FLUSH_ON_SHUTDOWN` / `APILENS_SHUTDOWN_TIMEOUT` settings. |
| Flask / any WSGI app | `atexit` | |

Each hook flushes at most once per client; if the deadline passes, the leftovers
are dropped and the process exits on time. Set `flush_on_shutdown=False` (or the
`APILENS_FLUSH_ON_SHUTDOWN=false` env var, which wins over code) to turn the hooks
off and call `client.shutdown(flush=True)` yourself.

**Multi-worker servers (gunicorn, uvicorn `--workers`, uwsgi).** Each worker
process has its own client and queue and flushes its own on exit. gunicorn sends
`SIGTERM` to workers on restart, `--max-requests` recycling and shutdown; a worker
that exits normally runs `atexit` (sync/gthread workers) or the lifespan shutdown
(`uvicorn.workers.UvicornWorker`). Keep gunicorn's `--graceful-timeout` (default
30 s) above `shutdown_timeout`, or the worker is `SIGKILL`ed mid-flush. Workers
killed by `SIGKILL`, the OOM killer or `--timeout` expiry run no hooks and lose
up to one `flush_interval` (3 s) of data. With uwsgi, enable `--enable-threads`
(the delivery thread needs it) and avoid `--skip-atexit`.

**Serverless (AWS Lambda, Cloud Functions, Cloud Run jobs).** The runtime freezes
or kills the process between invocations, so `atexit` and lifespan are not
reliable. Call `client.flush_all()` at the end of each invocation (or wrap the
handler body in `with client:` for one-shot functions), and keep
`flush_interval` short.

**CronJobs and scripts.** Use the client as a context manager
(`with ApiLensClient(...) as client:`) or call `client.shutdown(flush=True)` before
exit. In Kubernetes, `terminationGracePeriodSeconds` (default 30 s) must exceed
`shutdown_timeout` plus your app's own shutdown time.

---

## Security & privacy

- **No implicit PII.** The SDK never reads auth headers or infers a consumer —
  identity is only what you pass to `set_consumer(...)`.
- **Sensitive headers are redacted** before they leave the process:
  `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `api-key`, `x-auth-token`, `x-amz-security-token`, and `x-csrf-token` are
  replaced with `[redacted]`. Header JSON is capped at 8 KB.
- **Default masking patterns always apply** (no configuration needed). Each
  regex is matched case-insensitively (`re.search`) against the *name*; matched
  values are stored as `[redacted]`:

  | Applies to | Built-in patterns (`apilens.client._sanitize`) |
  |---|---|
  | Query params (`DEFAULT_MASK_QUERY_PARAMS`) | `auth`, `api.?key`, `secret`, `token`, `password`, `pwd` |
  | Headers (`DEFAULT_MASK_HEADER_PATTERNS`) | `auth`, `api.?key`, `secret`, `token`, `cookie` |
  | JSON body fields (`DEFAULT_MASK_BODY_FIELDS`) | `password`, `pwd`, `token`, `secret`, `auth`, `card.?number`, `ccv`, `cvv`, `cvc`, `ssn` |

  So `/search?token=abc` is stored as `/search?token=[redacted]`. Body masking
  covers string **and** number values (plus nested objects/arrays under a
  matching name); booleans and `null` stay visible. `redact_query_params`,
  `redact_headers` and `redact_body_fields` (Django: `APILENS_REDACT_*`) add
  your own patterns on top — they extend the defaults, never replace them.
  Patterns are compiled once per middleware, never per request.
- **Body mask callbacks** handle what field patterns can't (form-encoded, XML,
  free text). `mask_request_body(info, body)` gets an `apilens.RequestInfo`
  (`method`, `path`, `raw_path`, `headers`, `content_type`) and
  `mask_response_body(info, body)` an `apilens.ResponseInfo` (`request`,
  `status_code`, `headers`, `content_type`), plus the captured bytes. Return
  the bytes to store, or `None` to store `[masked]`. Order is fixed: callback →
  your regex field patterns → built-in defaults, so the defaults still apply
  to whatever the callback returns. If the callback raises, the whole body is
  stored as `[masked]` — never the raw body.

  ```python
  def mask_request_body(info, body: bytes) -> bytes | None:
      if info.content_type.startswith("application/x-www-form-urlencoded"):
          return None  # drop form posts entirely
      return body

  app.add_middleware(ApiLensMiddleware, api_key="...", app_id="...",
                     mask_request_body=mask_request_body)
  # Django: APILENS_MASK_REQUEST_BODY = "myapp.apilens.mask_request_body"
  ```
- **Bodies are size-limited** to `max_payload_bytes` (64 KB default). Disable body
  capture entirely with `capture_payloads=False` (or `max_payload_bytes=0`, or
  `APILENS_MAX_PAYLOAD_BYTES=0` on Django).
- **TLS by default.** Certificates are verified unless you set `verify_tls=False`
  (intended for local development only).

---

## Network requirements

The SDK makes **outbound HTTPS calls only**; it never listens on a port.

| | |
|---|---|
| Egress host | `ingest.apilens.ai` (or the host in your `base_url`) |
| Port / protocol | `443/tcp`, HTTPS (TLS 1.2+) |
| Requests | `POST /v1/requests`, `/v1/traces`, `/v1/logs` (gzip JSON batches) from a background thread |

**Proxy.** Precedence, first match wins:

1. `proxy_url` on `ApiLensConfig`.
2. `APILENS_PROXY` env var (handy for Django and the framework helpers, which
   build the config for you).
3. The standard `HTTPS_PROXY` / `HTTP_PROXY` env vars (urllib's defaults).

`NO_PROXY` is honoured in every case. `https` ingest is tunnelled through the
proxy with `CONNECT`, so TLS stays end-to-end and the proxy never sees the API
key or payloads. Proxy credentials go in the URL
(`http://user:pass@proxy.corp:3128`) and are sent as `Proxy-Authorization: Basic`.

```bash
export APILENS_PROXY=http://proxy.corp:3128
```

**Custom CA.** If a TLS-inspecting proxy re-signs traffic with a corporate root,
point `ca_bundle_path` at a PEM bundle containing that root. It replaces the
system trust store for ingest calls, so include any public roots you still need.
Do not reach for `verify_tls=False` in production.

```python
ApiLensConfig(
    api_key="apilens_xxx",
    proxy_url="http://proxy.corp:3128",
    ca_bundle_path="/etc/ssl/certs/corp-root.pem",
)
```

An unreachable proxy or a certificate error is treated as a network error: the
batch is retried with backoff, then dropped and counted under
`drop_counts()["retries_exhausted"]`. Like every SDK error, it never raises into
your app; turn on the `apilens` logger to see it.

---

## OpenTelemetry interoperability

Already running OpenTelemetry? Attach the API Lens exporter to your existing
tracer provider and your OTel spans flow into API Lens as both request records
and a full trace waterfall — no double instrumentation.

```python
from apilens import ApiLensClient, ApiLensConfig, install_apilens_exporter

client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
install_apilens_exporter(
    client,
    app_id="orders-api",
    service_name="orders-api",
    environment="production",
)
```

The exporter reads standard HTTP semantic-convention attributes, so no
API-Lens-specific span attributes are required.

---

## Troubleshooting

**Nothing appears in the dashboard.**
1. Confirm the `api_key` is valid and belongs to the expected project.
2. Confirm `app_id` matches an app slug in that project.
3. Confirm `base_url` is correct (default `https://ingest.apilens.ai/v1`).
4. Enable SDK logging: `logging.getLogger("apilens").setLevel(logging.DEBUG)`.
5. Allow a few seconds for the batching interval before data shows up.

**`422 Unprocessable Entity` from ingest.** `app_id` is missing or doesn't match an
app in the key's project. Set it to the app slug from the dashboard.

**`401 Unauthorized`.** The API key is missing, revoked, or not project-scoped.

**Spans/traces are empty.** Ensure an `app_id` is set (spans require it) and, on
Django, that `APILENS_CAPTURE_SPANS` isn't `False`. Spans are captured
automatically for the request and for outbound `requests`/`httpx` calls.

---

## Support

- 📖 Documentation — https://apilens.ai/docs
- 📧 Email — hello@apilens.ai
- 🐛 Issues — https://github.com/apilens/apilens/issues

MIT licensed.
