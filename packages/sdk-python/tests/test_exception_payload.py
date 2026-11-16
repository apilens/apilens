"""Full exception payload in the auto error log (issue #907, M5 D3/D4).

The ``apilens.exception`` log carries ``module.QualName: msg``, the full
traceback with every chained cause and ``ExceptionGroup`` sub-exception, a
head+tail cap (64 KiB payload, 8 KiB message) and the ``exception.type`` /
``exception.message`` / ``exception.chain_depth`` attributes.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from apilens.client._exception import (
    MAX_EXCEPTION_MESSAGE,
    MAX_EXCEPTION_PAYLOAD,
    chain_depth,
    describe_exception,
    format_exception_full,
    qualified_type,
    truncate_head_tail,
)
from apilens.client._sanitize import mask_log_text
from apilens.client.middleware import _maybe_record_error


class DbError(Exception):
    pass


class ServiceError(Exception):
    class Inner(Exception):
        pass


class FakeClient:
    def __init__(self) -> None:
        self.config = SimpleNamespace(project_slug="", environment="test")
        self.logs: list = []

    def capture_log(self, record) -> None:
        self.logs.append(record)


def _three_deep() -> BaseException:
    try:
        try:
            try:
                raise DbError("connection reset")
            except DbError as e:
                raise ServiceError.Inner("query failed") from e
        except ServiceError.Inner as e:
            raise RuntimeError("checkout failed") from e
    except RuntimeError as e:
        return e
    raise AssertionError("unreachable")


def _record(exc: BaseException, status_code: int = 500):
    client = FakeClient()
    _maybe_record_error(
        exc=exc,
        status_code=status_code,
        trace_id="a" * 32,
        span_id="",
        method="GET",
        path="/x",
        consumer=None,
        client=client,
        app_id="app",
    )
    assert len(client.logs) == 1
    return client.logs[0]


def test_three_deep_raise_from_chain_keeps_every_type() -> None:
    exc = _three_deep()
    log = _record(exc)
    assert log.logger_name == "apilens.exception"
    for name in (f"{__name__}.DbError", f"{__name__}.ServiceError.Inner", "RuntimeError"):
        assert name in log.payload
    assert "connection reset" in log.payload
    assert "query failed" in log.payload
    assert log.attributes["exception.chain_depth"] == "3"


def test_message_uses_qualified_type() -> None:
    try:
        raise ServiceError.Inner("boom")
    except ServiceError.Inner as e:
        message, _, attrs = describe_exception(e)
    assert message == f"{__name__}.ServiceError.Inner: boom"
    assert attrs["exception.type"] == f"{__name__}.ServiceError.Inner"
    assert attrs["exception.message"] == "boom"
    assert qualified_type(ValueError("x")) == "ValueError"


def test_attributes_set_on_log() -> None:
    try:
        raise ValueError("bad input")
    except ValueError as e:
        log = _record(e)
    assert log.message == "ValueError: bad input"
    assert log.attributes == {
        "exception.type": "ValueError",
        "exception.message": "bad input",
        "exception.chain_depth": "1",
    }


def test_implicit_context_counts_and_suppressed_context_does_not() -> None:
    try:
        try:
            raise KeyError("k")
        except KeyError:
            raise ValueError("during handling")
    except ValueError as e:
        assert chain_depth(e) == 2
    try:
        try:
            raise KeyError("k")
        except KeyError:
            raise ValueError("clean") from None
    except ValueError as e:
        assert chain_depth(e) == 1


@pytest.mark.skipif(sys.version_info < (3, 11), reason="ExceptionGroup needs Python 3.11+")
def test_exception_group_sub_exceptions_present() -> None:
    subs = [ValueError(f"sub-{i}") for i in range(20)] + [DbError("db down")]
    try:
        raise ExceptionGroup("many failures", subs)  # noqa: F821
    except Exception as e:  # noqa: BLE001
        log = _record(e)
    assert "ExceptionGroup" in log.message
    assert "many failures" in log.payload
    # All sub-exceptions, past the stdlib default width of 15.
    for i in range(20):
        assert f"sub-{i}" in log.payload
    assert f"{__name__}.DbError: db down" in log.payload or "DbError: db down" in log.payload


def test_200kb_stack_keeps_first_and_last_line() -> None:
    try:
        try:
            try:
                raise DbError("ROOT-CAUSE")
            except DbError as e:
                raise ServiceError("middle " + "m" * 200_000) from e
        except ServiceError as e:
            raise RuntimeError("RAISED-LAST") from e
    except RuntimeError as e:
        log = _record(e)
        full = format_exception_full(e)
    assert len(full) > 200_000
    lines = full.rstrip("\n").splitlines()
    assert len(log.payload) <= MAX_EXCEPTION_PAYLOAD
    assert "chars truncated]" in log.payload
    assert log.payload.splitlines()[0] == lines[0]
    assert log.payload.rstrip("\n").splitlines()[-1] == lines[-1] == "RuntimeError: RAISED-LAST"
    assert f"{__name__}.DbError: ROOT-CAUSE" in log.payload
    assert log.message == "RuntimeError: RAISED-LAST"


def test_long_message_capped_head_tail() -> None:
    try:
        raise ValueError("START" + "x" * 50_000 + "END")
    except ValueError as e:
        log = _record(e)
    assert len(log.message) <= MAX_EXCEPTION_MESSAGE
    assert log.message.startswith("ValueError: START") and log.message.endswith("END")
    assert len(log.attributes["exception.message"]) <= MAX_EXCEPTION_MESSAGE


def test_truncate_head_tail_marker_and_limit() -> None:
    text = "HEAD" + "m" * 10_000 + "TAIL"
    out = truncate_head_tail(text, 1_000)
    assert len(out) <= 1_000
    assert out.startswith("HEAD") and out.endswith("TAIL")
    head, rest = out.split("\n…[", 1)
    count, tail = rest.split(" chars truncated]…\n", 1)
    assert int(count) == len(text) - len(head) - len(tail)
    assert truncate_head_tail("short", 1_000) == "short"


def test_masking_still_applies_to_payload() -> None:
    try:
        raise ValueError("login failed password=hunter2")
    except ValueError as e:
        _, payload, _ = describe_exception(e)
    assert "hunter2" not in mask_log_text(payload)
