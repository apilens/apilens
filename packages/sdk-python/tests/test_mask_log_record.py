"""``mask_log_record`` callback and built-in ``key=value`` masking on log records.

Order is callback -> built-in masking. ``None`` from the callback drops the
record; a callback that raises or returns a non-LogRecord drops it too
(fail closed). The built-ins always run and cannot be switched off.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone

import pytest

from apilens import ApiLensClient, ApiLensConfig, LogRecord
from apilens.client import spans
from apilens.client._sanitize import (
    DEFAULT_MASK_LOG_NAMES,
    REDACTED,
    mask_log_attributes,
    mask_log_text,
)


def _record(**overrides) -> LogRecord:
    fields = {
        "timestamp": datetime.now(tz=timezone.utc),
        "environment": "test",
        "level": "ERROR",
        "message": "boom",
        "trace_id": "a" * 32,
    }
    fields.update(overrides)
    return LogRecord(**fields)


def _client(**config) -> ApiLensClient:
    return ApiLensClient(ApiLensConfig(api_key="apilens_test", **config), start_worker=False)


def _queued(client: ApiLensClient) -> list[LogRecord]:
    return list(client._log_queue)


# ── built-in masking of log text ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("token=abc123", f"token={REDACTED}"),
        ("GET /x?access_token=abc&q=shoes", f"GET /x?access_token={REDACTED}&q=shoes"),
        ("password: hunter2 rejected", f"password: {REDACTED} rejected"),
        ("Authorization: Bearer eyJhbGci.x.y", f"Authorization: {REDACTED}"),
        ("{'password': 'hunter2', 'user': 'bob'}", f"{{'password': '{REDACTED}', 'user': 'bob'}}"),
        ('{"api_key": "sk_live_1"}', f'{{"api_key": "{REDACTED}"}}'),
        ("API-KEY=k1, SECRET=s1", f"API-KEY={REDACTED}, SECRET={REDACTED}"),
        ("card_number=4242424242424242", f"card_number={REDACTED}"),
        ("session cookie=abc; path=/", f"session cookie={REDACTED}; path=/"),
    ],
)
def test_mask_log_text_masks_default_sensitive_pairs(text: str, expected: str) -> None:
    assert mask_log_text(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "division by zero",
        "user=bob status=500",
        "token expired",  # no key=value pair
        'File "/app/auth.py", line 5, in login',
    ],
)
def test_mask_log_text_leaves_non_sensitive_text_unchanged(text: str) -> None:
    assert mask_log_text(text) == text


def test_exception_type_names_are_not_treated_as_pairs() -> None:
    text = "InvalidTokenError: signature expired (token=abc)"
    assert mask_log_text(text) == f"InvalidTokenError: signature expired (token={REDACTED})"


def test_default_log_names_cover_all_builtin_patterns() -> None:
    for name in ("auth", "token", "secret", "password", "pwd", "cookie", "ssn", "cvv"):
        assert any(name == p for p in DEFAULT_MASK_LOG_NAMES)
    assert len(DEFAULT_MASK_LOG_NAMES) == len(set(DEFAULT_MASK_LOG_NAMES))


def test_mask_log_attributes_by_key_and_value() -> None:
    attrs = {"db.password": "hunter2", "query": "select 1 where token=abc", "count": "3"}
    assert mask_log_attributes(attrs) == {
        "db.password": REDACTED,
        "query": f"select 1 where token={REDACTED}",
        "count": "3",
    }
    assert mask_log_attributes(None) is None


# ── client: built-ins always apply ──────────────────────────────────────────


def test_builtin_masking_without_callback() -> None:
    client = _client()
    client.capture_log(
        _record(
            message="charge failed: api_key=sk_live_1",
            payload='Traceback...\nValueError: {"password": "hunter2"}',
            attributes={"auth_header": "Basic xyz"},
        )
    )
    (rec,) = _queued(client)
    assert rec.message == f"charge failed: api_key={REDACTED}"
    assert "hunter2" not in rec.payload
    assert rec.attributes == {"auth_header": REDACTED}


# ── client: mask_log_record callback ────────────────────────────────────────


def test_callback_can_edit_message_and_attributes() -> None:
    def mask(record: LogRecord) -> LogRecord:
        record.message = record.message.replace("alice@example.com", "<email>")
        record.attributes = {**(record.attributes or {}), "masked": "yes"}
        return record

    client = _client(mask_log_record=mask)
    client.capture_log(_record(message="no such user alice@example.com", attributes={"a": "1"}))
    (rec,) = _queued(client)
    assert rec.message == "no such user <email>"
    assert rec.attributes == {"a": "1", "masked": "yes"}


def test_callback_can_return_a_new_record() -> None:
    client = _client(mask_log_record=lambda r: dataclasses.replace(r, message="replaced"))
    client.capture_log(_record())
    assert [r.message for r in _queued(client)] == ["replaced"]


def test_callback_returning_none_drops_the_record() -> None:
    client = _client(mask_log_record=lambda r: None if "/admin" in r.endpoint_path else r)
    client.capture_log(_record(endpoint_path="/admin/users"))
    client.capture_log(_record(endpoint_path="/orders"))
    assert [r.endpoint_path for r in _queued(client)] == ["/orders"]
    assert client.queued_bytes > 0


def test_builtins_run_after_the_callback() -> None:
    # The callback cannot switch the built-in masking off, even by
    # re-introducing a secret.
    client = _client(mask_log_record=lambda r: dataclasses.replace(r, message="token=leaked"))
    client.capture_log(_record())
    (rec,) = _queued(client)
    assert rec.message == f"token={REDACTED}"


def test_callback_sees_the_unmasked_record() -> None:
    seen: list[str] = []

    def mask(record: LogRecord) -> LogRecord:
        seen.append(record.message)
        return record

    client = _client(mask_log_record=mask)
    client.capture_log(_record(message="token=abc"))
    assert seen == ["token=abc"]


@pytest.mark.parametrize("bad", [lambda r: 1 / 0, lambda r: "not a record", lambda r: {"message": "x"}])
def test_failing_callback_drops_the_record(bad) -> None:
    client = _client(mask_log_record=bad)
    client.capture_log(_record(message="token=abc"))
    assert _queued(client) == []


def test_callback_not_called_when_disabled() -> None:
    calls: list[LogRecord] = []
    client = _client(enabled=False, mask_log_record=lambda r: calls.append(r) or r)
    client.capture_log(_record())
    assert calls == []
    assert _queued(client) == []


# ── auto error-trace logs go through the same path ──────────────────────────


def test_auto_error_trace_log_is_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(mask_log_record=lambda r: dataclasses.replace(r, logger_name="masked"))
    recorder = spans._SpanRecorder(client, app_id="app", environment="test", service_name="")
    monkeypatch.setattr(spans, "_recorder", recorder)
    spans.record_error_log(
        trace_id="b" * 32,
        span_id="c" * 16,
        level="error",
        message="ValueError: bad secret=s3cr3t",
        payload="Traceback (most recent call last):\n  password=hunter2",
    )
    (rec,) = _queued(client)
    assert rec.logger_name == "masked"
    assert rec.message == f"ValueError: bad secret={REDACTED}"
    assert "hunter2" not in rec.payload
