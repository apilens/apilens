# API Lens Python SDK

Production-ready Python ingest client for API Lens with OpenTelemetry integration.

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
    method="GET",
    path="/health",
    status_code=200,
    response_time_ms=12.4,
)

client.shutdown(flush=True)
```

## FastAPI

```python
from fastapi import FastAPI
from apilens import ApiLensClient, ApiLensConfig
from apilens.fastapi import instrument_app

app = FastAPI()

client = ApiLensClient(
    ApiLensConfig(
        api_key="your_app_api_key",
        base_url="https://api.apilens.ai/api/v1",
        environment="production",
    )
)

instrument_app(app, client)

@app.get("/v1/orders")
def list_orders():
    return {"ok": True}
```

## Starlette

```python
from starlette.applications import Starlette
from apilens import ApiLensClient, ApiLensConfig
from apilens.starlette import instrument_app

app = Starlette()
client = ApiLensClient(ApiLensConfig(api_key="your_app_api_key"))
instrument_app(app, client)
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

instrument_app(app, client)

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

APILENS_API_KEY = "your_app_api_key"
APILENS_BASE_URL = "https://api.apilens.ai/api/v1"
APILENS_ENVIRONMENT = "production"
```

## Litestar

```python
from litestar import Litestar
from apilens import ApiLensClient, ApiLensConfig
from apilens.litestar import ApiLensPlugin

client = ApiLensClient(ApiLensConfig(api_key="your_app_api_key"))
app = Litestar(route_handlers=[], plugins=[ApiLensPlugin(client=client)])
```

## BlackSheep

```python
from blacksheep import Application
from apilens import ApiLensClient, ApiLensConfig
from apilens.blacksheep import instrument_app

app = Application()
client = ApiLensClient(ApiLensConfig(api_key="your_app_api_key"))
instrument_app(app, client)
```

## Notes

- default flush interval: `3s`
- default batch size: `200`
- max ingest batch payload sent per request: follows backend limit (`<= 1000`)
- call `client.shutdown(flush=True)` on graceful shutdown

## Roadmap

Next adapters planned after FastAPI and Flask:

- Django
- Starlette
- Aiohttp
