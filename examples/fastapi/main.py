"""APILens example app: FastAPI + the Python SDK (apilenss).

The same endpoint set exists in examples/express and examples/spring so the
e2e, failure-drill and benchmark tasks can drive all three SDKs alike:

    GET  /health          liveness (excluded from capture by the SDK defaults)
    GET  /orders/{id}     JSON response, templated path
    POST /orders          JSON body; 201, or 422 with validation errors
    POST /login           application/x-www-form-urlencoded body
    POST /upload          multipart/form-data (file + description)
    GET  /boom            unhandled exception -> 500
    GET  /outbound        outbound HTTP call to EXAMPLE_OUTBOUND_URL

Configuration is environment only:

    EXAMPLE_POSTURE   off | metadata | redacted | full (default full).
                      `off` does not install the middleware at all (the
                      benchmark baseline); the others are the SDK
                      capture_profile presets.
    APILENS_*         read by the SDK itself (APILENS_API_KEY, APILENS_APP_ID,
                      APILENS_BASE_URL, APILENS_ENVIRONMENT, APILENS_SAMPLE_RATE,
                      APILENS_REDACT_*, APILENS_EXCLUDE_*, ...).
"""

from __future__ import annotations

import os
from typing import Annotated

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

POSTURES = ("off", "metadata", "redacted", "full")

posture = os.environ.get("EXAMPLE_POSTURE", "full").strip().lower() or "full"
if posture not in POSTURES:
    raise SystemExit(
        f"EXAMPLE_POSTURE must be one of {', '.join(POSTURES)}, got {posture!r}"
    )

outbound_url = os.environ.get("EXAMPLE_OUTBOUND_URL", "").strip()

app = FastAPI(title="APILens FastAPI example")

# Consumer attribution, the way a real API does it: each caller is a user who
# sends a personal access token as `Authorization: Bearer <token>`. The app looks
# the token up and hands the SDK who called: the user (id, name) and, as the
# group, the company the user belongs to. The token itself never reaches APILens:
# the SDKs redact `authorization` by default. A missing or unknown token is an
# anonymous caller. The same users exist in examples/fastapi, examples/express
# and examples/spring.
USERS: dict[str, dict[str, str]] = {
    "demo_tok_priya": {"id": "usr_1f3a9c", "name": "Priya Shah", "group": "Acme Corp"},
    "demo_tok_daniel": {"id": "usr_2b7e41", "name": "Daniel Okafor", "group": "Acme Corp"},
    "demo_tok_mei": {"id": "usr_3c9d02", "name": "Mei Lin", "group": "Acme Corp"},
    "demo_tok_lucas": {"id": "usr_4a1f77", "name": "Lucas Moreau", "group": "Acme Corp"},
    "demo_tok_sofia": {"id": "usr_5e6b13", "name": "Sofia Rossi", "group": "Globex Logistics"},
    "demo_tok_arjun": {"id": "usr_6d2c58", "name": "Arjun Mehta", "group": "Globex Logistics"},
    "demo_tok_hana": {"id": "usr_7f8a90", "name": "Hana Kim", "group": "Globex Logistics"},
    "demo_tok_omar": {"id": "usr_8b3e26", "name": "Omar Haddad", "group": "Initech"},
    "demo_tok_emma": {"id": "usr_9c4f31", "name": "Emma Schulz", "group": "Initech"},
    "demo_tok_kenji": {"id": "usr_a15d84", "name": "Kenji Watanabe", "group": "Umbrella Health"},
    "demo_tok_ana": {"id": "usr_b26e95", "name": "Ana Silva", "group": "Umbrella Health"},
    "demo_tok_noah": {"id": "usr_c37fa6", "name": "Noah Williams", "group": "Umbrella Health"},
}


def consumer_from_token(_scope, headers: dict[str, str]) -> dict[str, str] | None:
    scheme, _, token = headers.get("authorization", "").partition(" ")
    return USERS.get(token.strip()) if scheme.lower() == "bearer" else None


if posture != "off":
    from apilens.fastapi import ApiLensGatewayMiddleware

    # api_key, app_id, base_url, environment and every capture option come
    # from APILENS_* env vars; the posture picks the capture profile.
    app.add_middleware(
        ApiLensGatewayMiddleware,
        capture_profile=posture,
        get_consumer=consumer_from_token,
    )


class OrderIn(BaseModel):
    item: str = Field(min_length=1)
    quantity: int = Field(gt=0)
    email: str | None = None
    card_number: str | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "posture": posture}


@app.get("/orders/{order_id}")
def get_order(order_id: int) -> dict[str, object]:
    return {"id": order_id, "item": "widget", "quantity": 2, "status": "shipped"}


@app.post("/orders", status_code=201)
def create_order(order: OrderIn) -> dict[str, object]:
    return {
        "id": 1001,
        "item": order.item,
        "quantity": order.quantity,
        "status": "created",
    }


@app.post("/login")
def login(
    username: Annotated[str, Form()],
    password: Annotated[str, Form()],
) -> dict[str, object]:
    return {
        "username": username,
        "token": "example-session-token",
        "password_length": len(password),
    }


@app.post("/upload")
async def upload(
    file: Annotated[UploadFile, File()],
    description: Annotated[str, Form()] = "",
) -> dict[str, object]:
    data = await file.read()
    return {"filename": file.filename, "size": len(data), "description": description}


@app.get("/boom")
def boom() -> None:
    raise RuntimeError("example failure: /boom always raises")


@app.get("/outbound")
async def outbound() -> dict[str, object]:
    if not outbound_url:
        raise HTTPException(status_code=503, detail="EXAMPLE_OUTBOUND_URL is not set")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(outbound_url)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"outbound call failed: {exc}"
        ) from exc
    return {"url": outbound_url, "status": resp.status_code}
