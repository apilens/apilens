"""Opt-in frame locals in exception traces (issue #913, M5 D5).

``capture_locals`` (env / Django ``APILENS_CAPTURE_LOCALS``) is off by default.
When on, the innermost 10 frames of every exception in the chain get a
``Locals:`` section: up to 20 names, ``repr`` capped at 256 chars, values whose
name matches the redaction rules masked before truncation. Modules, functions
and classes are skipped. The ``metadata`` and ``redacted`` profiles force it off.
"""

from __future__ import annotations

import json
import re
from types import SimpleNamespace

import pytest

from apilens.client._exception import (
    MAX_LOCAL_REPR,
    MAX_LOCALS_FRAMES,
    MAX_LOCALS_PER_FRAME,
    describe_exception,
)
from apilens.client._policy import ALLOW_ALL, Policy
from apilens.client._profile import effective_capture_locals
from apilens.client._sanitize import Redactor
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware, _maybe_record_error


class FakeClient:
    def __init__(self, policy: Policy = ALLOW_ALL) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test")
        self.current = policy
        self.records: list[dict] = []
        self.spans: list = []
        self.logs: list = []

    def policy(self, app_id: str = "") -> Policy:
        return self.current

    def capture(self, **kwargs) -> None:
        self.records.append(kwargs)

    def capture_span(self, record) -> None:
        self.spans.append(record)

    def capture_log(self, record) -> None:
        self.logs.append(record)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("APILENS_CAPTURE_LOCALS", "APILENS_CAPTURE_PROFILE", "APILENS_CAPTURE_SPANS", "APILENS_SAMPLE_RATE"):
        monkeypatch.delenv(name, raising=False)


def checkout(card_number: str) -> None:
    password = "hunter2"  # noqa: F841 - read from the frame
    api_token = "tok_live_abc"  # noqa: F841
    order = {"id": 42, "secret": "s3cr3t", "items": ["book"]}  # noqa: F841
    quantity = 3  # noqa: F841
    helper = len  # noqa: F841 - builtin function: skipped
    module = json  # noqa: F841 - module: skipped
    klass = ValueError  # noqa: F841 - class: skipped
    raise RuntimeError("card declined")


def _raise(fn, *args) -> BaseException:
    try:
        fn(*args)
    except BaseException as exc:  # noqa: BLE001
        return exc
    raise AssertionError("did not raise")


def _locals_sections(payload: str) -> list[dict[str, str]]:
    """Every ``Locals:`` section in a payload, as ``{name: value}``."""
    sections: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in payload.splitlines():
        if line == "    Locals:":
            current = {}
            sections.append(current)
        elif current is not None and line.startswith("      ") and " = " in line:
            name, value = line.strip().split(" = ", 1)
            current[name] = value
        else:
            current = None
    return sections


def test_default_off():
    _, payload, _ = describe_exception(_raise(checkout, "4111"))
    assert "Locals:" not in payload
    assert "hunter2" not in payload


def test_on_captures_locals_and_masks_sensitive_names():
    _, payload, _ = describe_exception(_raise(checkout, "4111111111111111"), capture_locals=True, redactor=Redactor())
    inner = _locals_sections(payload)[-1]
    assert inner["quantity"] == "3"
    assert inner["password"] == "[redacted]"
    assert inner["api_token"] == "[redacted]"
    # A built-in body-field rule (card numbers) applies to local names too.
    assert inner["card_number"] == "[redacted]"
    # A sensitive key inside a repr is masked as well.
    assert "s3cr3t" not in inner["order"] and "'id': 42" in inner["order"]
    # Modules, functions and classes are skipped.
    assert not {"helper", "module", "klass"} & inner.keys()
    for secret in ("hunter2", "tok_live_abc", "4111111111111111", "s3cr3t"):
        assert secret not in "\n".join(inner.values())
    for secret in ("hunter2", "tok_live_abc", "s3cr3t"):
        assert secret not in payload


def test_user_redaction_rules_apply_to_local_names():
    def handler():
        customer_ref = "cust-123"  # noqa: F841
        raise ValueError("x")

    _, payload, _ = describe_exception(
        _raise(handler), capture_locals=True, redactor=Redactor(body_fields=[r"^customer_ref$"])
    )
    assert _locals_sections(payload)[-1]["customer_ref"] == "[redacted]"


def test_caps_names_per_frame_and_repr_length():
    def wide():
        big = "x" * 10_000  # noqa: F841
        a0 = a1 = a2 = a3 = a4 = a5 = a6 = a7 = a8 = a9 = 0  # noqa: F841
        b0 = b1 = b2 = b3 = b4 = b5 = b6 = b7 = b8 = b9 = 0  # noqa: F841
        c0 = c1 = c2 = c3 = c4 = c5 = c6 = c7 = c8 = c9 = 0  # noqa: F841
        raise ValueError("wide")

    _, payload, _ = describe_exception(_raise(wide), capture_locals=True)
    inner = _locals_sections(payload)[-1]
    assert len(inner) == MAX_LOCALS_PER_FRAME
    assert len(inner["big"]) <= MAX_LOCAL_REPR
    assert inner["big"].endswith("…")


def test_caps_innermost_frames():
    def recurse(depth: int) -> None:
        marker = depth  # noqa: F841
        if depth == 0:
            raise ValueError("bottom")
        # Alternate call lines so the stdlib does not collapse repeated frames.
        if depth % 2:
            recurse(depth - 1)
        else:
            recurse(depth - 1)

    _, payload, _ = describe_exception(_raise(recurse, 15), capture_locals=True)
    sections = _locals_sections(payload)
    assert len(sections) == MAX_LOCALS_FRAMES
    # Innermost frames: depth 9 .. 0.
    assert [s["marker"] for s in sections] == [str(d) for d in range(MAX_LOCALS_FRAMES - 1, -1, -1)]


def test_chained_causes_get_locals_too():
    def root():
        db_host = "db-1"  # noqa: F841
        raise ConnectionError("reset")

    def outer():
        try:
            root()
        except ConnectionError as exc:
            attempt = 2  # noqa: F841
            raise RuntimeError("failed") from exc

    _, payload, _ = describe_exception(_raise(outer), capture_locals=True)
    flat = {k: v for s in _locals_sections(payload) for k, v in s.items()}
    assert flat["db_host"] == "'db-1'"
    assert flat["attempt"] == "2"


def test_mask_happens_before_truncation():
    def handler():
        blob = {"filler": "y" * (MAX_LOCAL_REPR - 30), "password": "p" * 400}  # noqa: F841
        raise ValueError("x")

    _, payload, _ = describe_exception(_raise(handler), capture_locals=True)
    blob = _locals_sections(payload)[-1]["blob"]
    assert "ppp" not in blob
    assert len(blob) <= MAX_LOCAL_REPR


# ── options and profiles ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("profile", "expected"),
    [(None, True), ("full", True), ("metadata", False), ("redacted", False), ("REDACTED", False)],
)
def test_profiles_override(profile, expected):
    assert effective_capture_locals(True, profile) is expected
    assert effective_capture_locals(False, profile) is False


def _asgi(**kwargs) -> ApiLensASGIMiddleware:
    async def app(scope, receive, send):  # pragma: no cover - never called
        pass

    return ApiLensASGIMiddleware(app, FakeClient(), flush_on_shutdown=False, capture_spans=False, **kwargs)


def test_middleware_default_off_and_kwarg_on():
    assert _asgi().capture_locals is False
    assert _asgi(capture_locals=True).capture_locals is True
    wsgi = ApiLensWSGIMiddleware(lambda e, s: [], FakeClient(), flush_on_shutdown=False, capture_locals=True)
    assert wsgi.capture_locals is True


def test_middleware_profiles_force_off_even_if_set():
    assert _asgi(capture_locals=True, capture_profile="metadata").capture_locals is False
    assert _asgi(capture_locals=True, capture_profile="redacted").capture_locals is False
    assert _asgi(capture_locals=True, capture_profile="full").capture_locals is True


def test_env_var(monkeypatch):
    monkeypatch.setenv("APILENS_CAPTURE_LOCALS", "true")
    assert _asgi().capture_locals is True
    monkeypatch.setenv("APILENS_CAPTURE_PROFILE", "metadata")
    assert _asgi().capture_locals is False


def test_error_log_carries_locals_only_when_on():
    exc = _raise(checkout, "4111")
    for on in (False, True):
        client = FakeClient()
        _maybe_record_error(
            exc=exc,
            status_code=500,
            trace_id="a" * 32,
            span_id="",
            method="POST",
            path="/checkout",
            consumer=None,
            client=client,
            app_id="shop",
            capture_locals=on,
            redactor=Redactor(),
        )
        (log,) = client.logs
        assert ("Locals:" in log.payload) is on
        assert "hunter2" not in log.payload


# ── frameworks ──────────────────────────────────────────────────────────────


def _flask_payload(**kwargs) -> str:
    flask = pytest.importorskip("flask")
    from apilens.flask import instrument_flask

    client = FakeClient()
    app = flask.Flask(__name__)

    @app.post("/checkout")
    def view():
        checkout("4111")
        return "ok"

    instrument_flask(app, client, app_id="shop", flush_on_shutdown=False, **kwargs)
    resp = app.test_client().post("/checkout")
    resp.get_data()
    resp.close()
    (log,) = client.logs
    return log.payload


def test_flask_capture_locals():
    assert "Locals:" not in _flask_payload()
    payload = _flask_payload(capture_locals=True)
    assert re.search(r"^      password = \[redacted\]$", payload, re.M)
    assert re.search(r"^      quantity = 3$", payload, re.M)
    assert "Locals:" not in _flask_payload(capture_locals=True, capture_profile="redacted")


@pytest.fixture
def django_client(monkeypatch):
    django = pytest.importorskip("django")
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False,
            ALLOWED_HOSTS=["*"],
            ROOT_URLCONF=__name__,
            APILENS_API_KEY="apilens_test",
            APILENS_APP_ID="shop",
        )
        django.setup()

    import apilens.django as apilens_django

    client = FakeClient()
    monkeypatch.setattr(apilens_django, "_client_singleton", client)
    return client


def _django_checkout(request):
    checkout("4111")


urlpatterns: list = []


def _django_post(**apilens_settings):
    from django.test import Client, override_settings
    from django.urls import path

    global urlpatterns
    urlpatterns = [path("checkout", _django_checkout)]
    with override_settings(
        ROOT_URLCONF=__name__,
        ALLOWED_HOSTS=["*"],
        DEBUG=False,
        DEBUG_PROPAGATE_EXCEPTIONS=False,
        MIDDLEWARE=["apilens.django.ApiLensDjangoMiddleware"],
        APILENS_FLUSH_ON_SHUTDOWN=False,
        **apilens_settings,
    ):
        return Client(raise_request_exception=False).post("/checkout")


def test_django_default_off(django_client):
    assert _django_post().status_code == 500
    (log,) = django_client.logs
    assert "Locals:" not in log.payload


def test_django_setting_on(django_client):
    assert _django_post(APILENS_CAPTURE_LOCALS=True).status_code == 500
    (log,) = django_client.logs
    assert re.search(r"^      api_token = \[redacted\]$", log.payload, re.M)
    assert re.search(r"^      quantity = 3$", log.payload, re.M)


def test_django_profile_forces_off(django_client):
    _django_post(APILENS_CAPTURE_LOCALS=True, APILENS_CAPTURE_PROFILE="metadata")
    (log,) = django_client.logs
    assert "Locals:" not in log.payload
