"""Endpoint route-template resolution — heuristic + per-framework."""

from __future__ import annotations

import datetime

import pytest

from apilens.client._routes import (
    _transform_django_route,
    _transform_flask_rule,
    django_route_template,
    flask_route_template,
    parametrize_path,
    resolve_endpoint_path,
    starlette_route_template,
)
from apilens.client.models import RequestRecord


# ── Heuristic fallback ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("/product/123", "/product/{id}"),
        ("/product/324", "/product/{id}"),  # groups with the above
        ("/users/550e8400-e29b-41d4-a716-446655440000", "/users/{uuid}"),
        ("/files/507f1f77bcf86cd799439011", "/files/{hash}"),  # Mongo ObjectId
        ("/o/01ARZ3NDEKTSV4RRFFQ69G5FAV", "/o/{id}"),  # ULID
        ("/orders/123/items/456", "/orders/{id}/items/{id}"),
        ("/health", "/health"),  # plain word untouched
        ("/api/v2/openapi.json", "/api/v2/openapi.json"),  # file, no digit-id
        ("/", "/"),
        ("", "/"),  # empty normalizes to root
    ],
)
def test_parametrize_path(raw, expected):
    assert parametrize_path(raw) == expected


def test_parametrize_groups_distinct_ids():
    assert parametrize_path("/product/123") == parametrize_path("/product/999")


# ── resolve precedence ──────────────────────────────────────────────────────


def test_template_wins_over_heuristic():
    assert resolve_endpoint_path("/product/{id}", "/product/123", True) == "/product/{id}"


def test_heuristic_when_no_template():
    assert resolve_endpoint_path(None, "/product/123", True) == "/product/{id}"


def test_raw_kept_when_parametrize_off():
    assert resolve_endpoint_path(None, "/product/123", False) == "/product/123"


# ── Django transform ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "route, expected",
    [
        ("products/<int:pk>/", "/products/{pk}/"),
        ("api/orders/<uuid:id>", "/api/orders/{id}"),
        ("items/<slug:name>/", "/items/{name}/"),
        (r"^articles/(?P<year>[0-9]{4})/(?P<slug>[\w-]+)/$", "/articles/{year}/{slug}/"),
    ],
)
def test_django_transform(route, expected):
    assert _transform_django_route(route) == expected


def test_django_route_template_from_request():
    class M:
        route = "products/<int:pk>/"

    class Req:
        resolver_match = M()

    assert django_route_template(Req()) == "/products/{pk}/"
    assert django_route_template(type("R", (), {"resolver_match": None})()) is None


# ── Flask transform ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "rule, expected",
    [
        ("/product/<int:id>", "/product/{id}"),
        ("/users/<uuid:uid>/posts/<slug>", "/users/{uid}/posts/{slug}"),
        ("/static/<path:filename>", "/static/{filename}"),
    ],
)
def test_flask_transform(rule, expected):
    assert _transform_flask_rule(rule) == expected


# ── to_wire carries both paths ──────────────────────────────────────────────


def test_to_wire_includes_raw_path():
    rec = RequestRecord(
        timestamp=datetime.datetime(2026, 7, 2, tzinfo=datetime.timezone.utc),
        environment="prod",
        method="get",
        path="/product/{id}",
        raw_path="/product/123",
        status_code=200,
        response_time_ms=1.0,
    )
    wire = rec.to_wire()
    assert wire["path"] == "/product/{id}"
    assert wire["raw_path"] == "/product/123"


def test_to_wire_raw_path_defaults_to_path():
    rec = RequestRecord(
        timestamp=datetime.datetime(2026, 7, 2, tzinfo=datetime.timezone.utc),
        environment="prod",
        method="get",
        path="/health",
        status_code=200,
        response_time_ms=1.0,
    )
    assert rec.to_wire()["raw_path"] == "/health"


# ── Real Starlette / FastAPI routing ────────────────────────────────────────


def _http_scope(app, path):
    return {
        "type": "http",
        "method": "GET",
        "path": path,
        "root_path": "",
        "headers": [],
        "app": app,
        "query_string": b"",
    }


def test_starlette_real_routes():
    starlette = pytest.importorskip("starlette")
    from starlette.applications import Starlette
    from starlette.routing import Mount, Route

    async def handler(request):  # pragma: no cover - never called
        ...

    app = Starlette(
        routes=[
            Route("/product/{id}", handler),
            Route("/health", handler),
            Mount("/api", routes=[Route("/orders/{oid}", handler)]),
        ]
    )
    assert starlette_route_template(_http_scope(app, "/product/123")) == "/product/{id}"
    assert starlette_route_template(_http_scope(app, "/product/999")) == "/product/{id}"
    assert starlette_route_template(_http_scope(app, "/health")) == "/health"
    # Unmatched → None → caller falls back to the heuristic.
    assert starlette_route_template(_http_scope(app, "/nope/123")) is None


def test_fastapi_real_routes():
    fastapi = pytest.importorskip("fastapi")
    from fastapi import FastAPI

    app = FastAPI()

    @app.get("/product/{id}")
    async def _get(id: int):  # pragma: no cover
        return {}

    assert starlette_route_template(_http_scope(app, "/product/123")) == "/product/{id}"


# ── Real Flask routing ──────────────────────────────────────────────────────


def test_flask_real_routes():
    flask = pytest.importorskip("flask")
    from werkzeug.test import EnvironBuilder

    app = flask.Flask(__name__)

    @app.route("/product/<int:id>")
    def _p(id):  # pragma: no cover
        return ""

    env = EnvironBuilder(path="/product/123", method="GET").get_environ()
    assert flask_route_template(app, env) == "/product/{id}"
    env_miss = EnvironBuilder(path="/missing/1", method="GET").get_environ()
    assert flask_route_template(app, env_miss) is None


# ── End-to-end: drive a real request through the actual middleware ──────────


class _FakeClient:
    """Records capture() calls so we can assert the endpoint + raw paths."""

    def __init__(self):
        self.captured = []
        self.config = type(
            "Cfg", (), {"project_slug": "", "environment": "test", "enabled": True}
        )()

    def capture(self, **kw):
        self.captured.append(kw)


def test_fastapi_end_to_end():
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from apilens.frameworks.fastapi import instrument_fastapi

    client = _FakeClient()
    app = FastAPI()

    @app.get("/product/{id}")
    async def _get(id: int):
        return {"id": id}

    instrument_fastapi(app, client, app_id="", capture_spans=False)
    resp = TestClient(app).get("/product/123?ref=x")
    assert resp.status_code == 200
    rec = client.captured[-1]
    assert rec["path"] == "/product/{id}"
    assert rec["raw_path"] == "/product/123?ref=x"  # log keeps the query (redacted)


def test_flask_end_to_end():
    flask = pytest.importorskip("flask")
    from apilens.flask import instrument_app

    client = _FakeClient()
    app = flask.Flask(__name__)

    @app.route("/product/<int:id>")
    def _p(id):
        return {"id": id}

    instrument_app(app, client, app_id="", capture_spans=False)
    resp = app.test_client().get("/product/123?ref=x")
    # Force the WSGI iterator to exhaust so the middleware's finally (capture)
    # runs — a real WSGI server does this after streaming the response.
    resp.get_data()
    assert resp.status_code == 200
    rec = client.captured[-1]
    assert rec["path"] == "/product/{id}"
    assert rec["raw_path"] == "/product/123?ref=x"  # log keeps the query


def test_litestar_end_to_end():
    pytest.importorskip("litestar")
    from litestar import Litestar, get
    from litestar.testing import TestClient

    from apilens.litestar import ApiLensPlugin

    client = _FakeClient()

    @get("/product/{id:int}")
    async def _h(id: int) -> dict:
        return {"id": id}

    app = Litestar(
        route_handlers=[_h],
        plugins=[ApiLensPlugin(client=client, app_id="", capture_spans=False)],
    )
    with TestClient(app=app) as tc:
        resp = tc.get("/product/123")
    assert resp.status_code == 200
    rec = client.captured[-1]
    assert rec["raw_path"] == "/product/123"
    assert "{id" in rec["path"] and rec["path"] != rec["raw_path"]
