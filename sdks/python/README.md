# API Lens Python SDK

Production-ready Python ingest client for API Lens with OpenTelemetry integration.

> **⚠️ Breaking Change in v0.1.4:** The `app_id` parameter is now **required** for all integrations. Make sure to include it in your configuration.

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
        base_url="https://api.apilens.ai/api/v1",
        environment="production",
    )
)

client.capture(
    app_id="my-api-service",  # Required: App slug or UUID
    method="GET",
    path="/health",
    status_code=200,
    response_time_ms=12.4,
)

client.shutdown(flush=True)
```

### Getting your App ID

You can use either the **app slug** (recommended) or **app UUID**:

**Using App Slug (Recommended):**
```python
app_id = "my-api-service"  # Human-readable, easy to remember
```

**Using App UUID:**
1. Log in to [API Lens Dashboard](https://app.apilens.ai)
2. Navigate to your project
3. Select or create an app
4. Copy the **App UUID** from the app settings

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
    app_id="my-api-service",           # Required: App slug (or UUID)
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

## Flask

```python
from flask import Flask
from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_app

app = Flask(__name__)

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
APILENS_APP_ID = "your_app_id"  # Required: Your app ID from dashboard
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
| `app_id` | Yes | - | Your app slug or UUID from API Lens dashboard |
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

If you're getting 422 errors, make sure you've included the `app_id` parameter:

```python
# ❌ Old way (will fail)
app.add_middleware(
    ApiLensMiddleware,
    api_key="your_key",
)

# ✅ New way (required since v0.1.4)
app.add_middleware(
    ApiLensMiddleware,
    api_key="your_key",
    app_id="your_app_id",
)
```

### Finding Your App ID

**Using App Slug (Recommended):**
The slug is shown in the app list and is human-readable (e.g., `user-service`, `api-gateway`).

**Using App UUID:**
1. Log in to [API Lens Dashboard](https://app.apilens.ai)
2. Navigate to your project
3. Go to the Apps tab
4. Select your app or create a new one
5. Copy the UUID from the URL or app settings

Example formats:
- Slug: `user-service` (recommended)
- UUID: `c2537f6e-9b59-47ec-ab13-3559ae645c60`

### Data Not Appearing in Dashboard

1. Verify `app_id` is correct
2. Check that `api_key` is valid
3. Ensure `base_url` points to the correct endpoint
4. Check application logs for SDK errors
5. Wait up to 30 seconds for data to appear (batching delay)

## Migration from v0.1.3 to v0.1.4

**Breaking change:** The `app_id` parameter is now required.

Update all middleware/client configurations to include `app_id`:

```python
# Before (v0.1.3)
client = ApiLensClient(ApiLensConfig(api_key="..."))

# After (v0.1.4)
client = ApiLensClient(ApiLensConfig(
    api_key="...",
    # No app_id needed for client, but required when calling capture()
))

client.capture(
    app_id="your_app_id",  # Now required
    method="GET",
    path="/health",
    # ...
)
```

## Support

- 📧 Email: hello@apilens.ai
- 📖 Documentation: https://apilens.ai/docs
- 🐛 Issues: https://github.com/apilens/apilens/issues
