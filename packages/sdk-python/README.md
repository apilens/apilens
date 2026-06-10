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

## Identifying consumers

APILens **never** infers who the caller is — it does not read your auth
headers, JWTs or session. You attach the identity explicitly after your
own auth resolves. This keeps you in control of what identity (if any)
leaves your process.

Use `set_consumer(...)` (alias: `track_consumer`). The `request` argument is
**optional** — omit it when calling from a lifecycle hook that runs before
the framework request object is in scope.

---

### Flask — `@app.before_request`

```python
from flask import Flask, g
from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_flask, set_consumer

app = Flask(__name__)
client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
instrument_flask(app, client, app_id="my-flask-app")

@app.before_request
def identify_consumer():
    if g.current_user:                        # however YOUR app sets g.current_user
        set_consumer(                         # no request arg — uses a contextvar
            identifier=g.current_user["email"],   # required: stable id
            name=g.current_user.get("name"),      # optional: display name
            group=g.current_user.get("role"),     # optional: team / tier / org
        )
```

---

### FastAPI — Dependency injection

```python
from fastapi import Depends, FastAPI, Request
from apilens.fastapi import ApiLensMiddleware, set_consumer

app = FastAPI()
app.add_middleware(ApiLensMiddleware, api_key="apilens_xxx", app_id="my-fastapi-app")

async def consumer_dep(request: Request):
    user = getattr(request.state, "user", None)   # set by your auth middleware
    if user:
        set_consumer(
            request,                               # pass Request for ASGI state
            identifier=user.id,                    # required
            name=getattr(user, "username", None),  # optional
            group=getattr(user, "org_slug", None), # optional
        )

@app.get("/orders")
async def list_orders(_: None = Depends(consumer_dep)):
    ...
```

---

### Django — settings or view

**Option A** — centralized via `APILENS_GET_CONSUMER` in `settings.py` (runs
on every request automatically):

```python
# settings.py
MIDDLEWARE = [
    # ...
    "apilens.django.ApiLensDjangoMiddleware",
]
APILENS_API_KEY = "apilens_xxx"
APILENS_APP_ID  = "my-django-app"

def get_consumer(request):
    if request.user.is_authenticated:
        return {
            "identifier": request.user.email,
            "name": request.user.get_full_name(),
            "group": getattr(request.user, "role", ""),
        }
    return None

APILENS_GET_CONSUMER = get_consumer
# or as a dotted import path:
# APILENS_GET_CONSUMER = "myapp.consumers.get_consumer"
```

**Option B** — inline from a view (explicit call wins over the setting):

```python
from apilens.django import set_consumer

def my_view(request):
    if request.user.is_authenticated:
        set_consumer(request, identifier=request.user.email)
    ...
```

---

### Starlette

```python
from starlette.applications import Starlette
from starlette.requests import Request
from apilens import ApiLensClient, ApiLensConfig
from apilens.starlette import instrument_app, set_consumer

app = Starlette()
client = ApiLensClient(ApiLensConfig(api_key="apilens_xxx"))
instrument_app(app, client, app_id="my-starlette-app")

@app.route("/orders")
async def list_orders(request: Request):
    user = request.state.user   # set by your auth middleware
    if user:
        set_consumer(request, identifier=user["id"], name=user.get("name"))
    ...
```

---

### What `set_consumer` accepts

| Arg | Type | Notes |
|-----|------|-------|
| `identifier` | `str` | **Required.** Stable id — email, user id, API key prefix… |
| `name` | `str \| None` | Human-readable label shown in the dashboard |
| `group` | `str \| None` | Team, plan tier, org, role — use for grouping |

The function also accepts a plain string via `normalize_consumer(value)` or a
dict / object with `id`/`identifier`/`name`/`group` attributes, so you can
pass your user model directly to the centralized callbacks.

An explicit `set_consumer(...)` call always wins over a `get_consumer` callback.

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
