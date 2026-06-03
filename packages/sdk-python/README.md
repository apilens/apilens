# API Lens Python SDK

Production-ready Python ingest client for API Lens with OpenTelemetry integration.

> **Easy setup:** your API key is **project-level**. You only need two values —
> the project's `api_key` and the `app_id` of the app you're instrumenting.
> (`project_slug` is no longer required — the server derives the project from the key.)
>
> ```python
> from fastapi import FastAPI
> from apilens.fastapi import ApiLensMiddleware
>
> app = FastAPI()
> app.add_middleware(ApiLensMiddleware, api_key="apilens_xxx", app_id="orders-api")
> ```
>
> `base_url` defaults to `https://ingest.apilens.ai/v1` (override with `APILENS_BASE_URL` for local dev).

## Framework support matrix

| Framework | Integration Module | Integration Type | Client Type |
|---|---|---|---|
| FastAPI | `apilens.fastapi` | ASGI Middleware | AsyncIO |
| Starlette | `apilens.starlette` | ASGI Middleware | AsyncIO |
| Django REST Framework | `apilens.django` | Django Middleware | Threading |
| Django Ninja | `apilens.django` | Django Middleware | Threading |
| Flask | `apilens.flask` | WSGI Wrapper | Threading |
| Litestar | `apilens.litestar` | Plugin Protocol | AsyncIO |
| BlackSheep | `apilens.blacksheep` | ASGI Middleware | AsyncIO |

## What this SDK includes

- batched + retrying ingest client (`ApiLensClient`)
- OpenTelemetry span exporter (`apilens.otel`) for teams already on OTel
- first-class framework integrations listed above
- automatic request/response payload sampling (size-limited)

## Install

```bash
pip install apilenss
```

With framework support:

```bash
pip install 'apilenss[all]'
# or only one
pip install 'apilenss[fastapi]'
pip install 'apilenss[flask]'
```

Local development install (from repo):

```bash
pip install ./packages/sdk-python
pip install './packages/sdk-python[all]'
```

## The two values you need

- **`api_key`** — created on a project in the dashboard. It is **project-level**:
  one key works for every app in that project.
- **`app_id`** — the slug of the specific app you're instrumenting, so the SDK
  knows which app the traffic belongs to.

Find both in the [API Lens Dashboard](https://app.apilens.ai): the API key on the
project's API-keys page, the app slug on the app's page.

## Quick start (manual capture)

```python
from apilens import ApiLensClient, ApiLensConfig

client = ApiLensClient(
    ApiLensConfig(api_key="apilens_xxx")  # project-level key
)

client.capture(
    app_id="orders-api",  # which app in the project
    method="GET",
    path="/health",
    status_code=200,
    response_time_ms=12.4,
)

client.shutdown(flush=True)
```

## FastAPI

No OpenTelemetry instrumentation is required for endpoint + payload monitoring.

```python
from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware, set_consumer

app = FastAPI()

app.add_middleware(
    ApiLensMiddleware,
    api_key="apilens_xxx",   # project-level key
    app_id="orders-api",     # which app
)
```

**Environment variables (recommended):**

```python
import os
from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware

app = FastAPI()

app.add_middleware(
    ApiLensMiddleware,
    api_key=os.getenv("APILENS_API_KEY"),
    app_id=os.getenv("APILENS_APP_ID"),
)
```

Capture the calling consumer per request with `set_consumer(request, identifier=..., name=..., group=...)`.

## Starlette

```python
from starlette.applications import Starlette
from apilens import ApiLensClient, ApiLensConfig
from apilens.starlette import instrument_app

app = Starlette()
client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
instrument_app(app, client, app_id="orders-api")
```

## Flask

```python
from flask import Flask
from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_app

app = Flask(__name__)
client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
instrument_app(app, client, app_id="orders-api")
```

## Django (DRF + Django Ninja)

Add the middleware and two settings:

```python
MIDDLEWARE = [
    # ...
    "apilens.django.ApiLensDjangoMiddleware",
]

APILENS_API_KEY = "apilens_xxx"   # project-level key
APILENS_APP_ID = "orders-api"     # which app
```

## Litestar

```python
from litestar import Litestar
from apilens import ApiLensClient, ApiLensConfig
from apilens.litestar import ApiLensPlugin

client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
app = Litestar(route_handlers=[], plugins=[ApiLensPlugin(client=client, app_id="orders-api")])
```

## BlackSheep

```python
from blacksheep import Application
from apilens import ApiLensClient, ApiLensConfig
from apilens.blacksheep import instrument_app

app = Application()
client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
instrument_app(app, client, app_id="orders-api")
```

## Configuration Options

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `api_key` | Yes | - | Project-level API key from the dashboard |
| `app_id` | Yes | - | Slug of the app being instrumented |
| `project_slug` | No | derived from key | Only needed for clarity/validation; the key already identifies the project |
| `base_url` | No | `https://ingest.apilens.ai/v1` | API Lens ingest endpoint |
| `environment` | No | `production` | Environment name (e.g., production, staging, dev) |
| `enable_request_logging` | No | `True` | Enable request/response logging |
| `log_request_body` | No | `False` | Log request body (up to max size) |
| `log_response_body` | No | `False` | Log response body (up to max size) |

## Notes

- Default flush interval: `3s`
- Default batch size: `200`
- Max ingest batch payload sent per request: follows backend limit (`<= 1000`)
- Call `client.shutdown(flush=True)` on graceful shutdown

## Troubleshooting

### Data not appearing in the dashboard

1. Verify `api_key` is valid (and belongs to the right project).
2. Verify `app_id` matches an app in that project.
3. Ensure `base_url` points to the correct endpoint.
4. Check application logs for SDK errors.
5. Wait up to ~30s for data to appear (batching delay).

### 422 Unprocessable Entity

A 422 from the ingest endpoint usually means `app_id` is missing or doesn't match
an app in your key's project. Set `app_id` to the app's slug from the dashboard.

## Support

- 📧 Email: hello@apilens.ai
- 📖 Documentation: https://apilens.ai/docs
- 🐛 Issues: https://github.com/apilens/apilens/issues
