# API Lens Python SDK

Production-ready Python ingest client for API Lens with OpenTelemetry integration.

> **⚠️ Breaking Change in v0.1.6:** Both `project_slug` and `app_id` are now required for all ingest paths. Make sure both match the same project in your dashboard.

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
pip install ./sdks/python
pip install './sdks/python[all]'
```

## Quick start (manual capture)

```python
from apilens import ApiLensClient, ApiLensConfig

client = ApiLensClient(
    ApiLensConfig(
        api_key="your_app_api_key",
        project_slug="your-project-slug",
        base_url="https://api.apilens.ai/api/v1",
        environment="production",
    )
)

client.capture(
    app_id="my-api-service",  # Required: App slug inside that project
    method="GET",
    path="/health",
    status_code=200,
    response_time_ms=12.4,
)

client.shutdown(flush=True)
```

### Getting your Project Slug and App ID

You now need both:

```python
project_slug = "astra"
app_id = "sidecar"
```

Use the project slug from the project page, and the app slug from the app page in that same project.

## FastAPI

No OpenTelemetry instrumentation is required for endpoint + payload monitoring.

```python
from fastapi import FastAPI
from typing import Annotated
from fastapi import Depends, Request
from apilens.fastapi import ApiLensMiddleware, set_consumer

app = FastAPI()

app.add_middleware(
    ApiLensMiddleware,
    api_key="your_app_api_key",      # Required: Your API key
    project_slug="your-project-slug",  # Required: Project slug from dashboard
    app_id="my-api-service",           # Required: App slug inside that project
    base_url="https://api.apilens.ai/api/v1",
    env="production",
    enable_request_logging=True,
    log_request_body=True,
    log_response_body=True,
)

def identify_consumer(request: Request, user_id: Annotated[str, Depends(lambda: "user_123")]):
    set_consumer(request, identifier=user_id, name="Demo User", group="starter")

app.router.dependencies.append(Depends(identify_consumer))

@app.get("/v1/orders")
def list_orders():
    return {"ok": True}
```

**Environment Variables (Recommended):**

```python
import os
from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware

app = FastAPI()

app.add_middleware(
    ApiLensMiddleware,
    api_key=os.getenv("APILENS_API_KEY"),
    project_slug=os.getenv("APILENS_PROJECT_SLUG"),
    app_id=os.getenv("APILENS_APP_ID"),
    base_url=os.getenv("APILENS_BASE_URL", "https://api.apilens.ai/api/v1"),
    env=os.getenv("APILENS_ENVIRONMENT", "production"),
    enable_request_logging=True,
    log_request_body=True,
    log_response_body=True,
)
```

## Starlette

```python
from starlette.applications import Starlette
from apilens import ApiLensClient, ApiLensConfig
from apilens.starlette import instrument_app

app = Starlette()

client = ApiLensClient(
    ApiLensConfig(
        api_key="your_app_api_key",
        project_slug="your-project-slug",
        base_url="https://api.apilens.ai/api/v1",
        environment="production",
    )
)

instrument_app(
    app,
    client,
    project_slug="your-project-slug",
    app_id="your_app_id"
)
```

## Flask

```python
from flask import Flask
from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_app

app = Flask(__name__)

client = ApiLensClient(
    ApiLensConfig(
        api_key="your_app_api_key",
        project_slug="your-project-slug",
        base_url="https://api.apilens.ai/api/v1",
        environment="production",
    )
)

instrument_app(
    app,
    client,
    project_slug="your-project-slug",
    app_id="your_app_id"
)

@app.get("/v1/invoices")
def invoices():
    return {"ok": True}
```

## Django (DRF + Django Ninja)

Add middleware in Django settings:

```python
MIDDLEWARE = [
    # ...
    "apilens.django.ApiLensDjangoMiddleware",
]

# Required configuration
APILENS_API_KEY = "your_app_api_key"
APILENS_PROJECT_SLUG = "your-project-slug"
APILENS_APP_ID = "your_app_id"
APILENS_BASE_URL = "https://api.apilens.ai/api/v1"
APILENS_ENVIRONMENT = "production"
```

## Litestar

```python
from litestar import Litestar
from apilens import ApiLensClient, ApiLensConfig
from apilens.litestar import ApiLensPlugin

client = ApiLensClient(
    ApiLensConfig(
        api_key="your_app_api_key",
        base_url="https://api.apilens.ai/api/v1",
        environment="production",
    )
)

app = Litestar(
    route_handlers=[],
    plugins=[ApiLensPlugin(
        client=client,
        app_id="your_app_id"  # Required: Your app ID from dashboard
    )]
)
```

## BlackSheep

```python
from blacksheep import Application
from apilens import ApiLensClient, ApiLensConfig
from apilens.blacksheep import instrument_app

app = Application()

client = ApiLensClient(
    ApiLensConfig(
        api_key="your_app_api_key",
        base_url="https://api.apilens.ai/api/v1",
        environment="production",
    )
)

instrument_app(
    app,
    client,
    app_id="your_app_id"  # Required: Your app ID from dashboard
)
```

## Configuration Options

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `api_key` | Yes | - | Your API key from API Lens dashboard |
| `project_slug` | Yes | - | Your project slug from API Lens dashboard |
| `app_id` | Yes | - | Your app slug inside that project |
| `base_url` | No | `https://api.apilens.ai/api/v1` | API Lens ingest endpoint |
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

### 422 Unprocessable Entity Error

If you're getting 422 errors, make sure you've included both `project_slug` and `app_id`:

```python
# ❌ Old way (will fail)
app.add_middleware(
    ApiLensMiddleware,
    api_key="your_key",
)

# ✅ New way (required since v0.1.6)
app.add_middleware(
    ApiLensMiddleware,
    api_key="your_key",
    project_slug="your-project-slug",
    app_id="your_app_id",
)
```

### Finding Your Project Slug and App ID

1. Log in to [API Lens Dashboard](https://app.apilens.ai)
2. Open your project and copy the project slug
3. Open the app inside that project and copy the app slug

### Data Not Appearing in Dashboard

1. Verify `project_slug` is correct
2. Verify `app_id` is correct for that project
3. Check that `api_key` is valid
4. Ensure `base_url` points to the correct endpoint
5. Check application logs for SDK errors
6. Wait up to 30 seconds for data to appear (batching delay)

## Migration from v0.1.5 to v0.1.6

**Breaking change:** `project_slug` is now required alongside `app_id`.

Update all middleware/client configurations to include `project_slug` and `app_id`:

```python
# Before (v0.1.5)
client = ApiLensClient(ApiLensConfig(
    api_key="...",
))

# After (v0.1.6)
client = ApiLensClient(ApiLensConfig(
    api_key="...",
    project_slug="your-project-slug",
))

client.capture(
    app_id="your_app_id",
    method="GET",
    path="/health",
    # ...
)
```

## Support

- 📧 Email: hello@apilens.ai
- 📖 Documentation: https://apilens.ai/docs
- 🐛 Issues: https://github.com/apilens/apilens/issues
