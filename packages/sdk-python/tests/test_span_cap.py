"""Per-request span cap (D8): at most 2,000 child spans per request; the rest
are dropped and counted as ``span_cap`` in ``drop_counts()`` and the
heartbeat. The request's own server span is never capped."""

from __future__ import annotations

import pytest

from apilens.client import ApiLensClient, ApiLensConfig, spans
from apilens.client.trace import (
    MAX_SPANS_PER_REQUEST,
    begin_request_trace,
    end_request_trace,
    generate_span_id,
    set_detail_sampled,
    reset_detail_sampled,
)


@pytest.fixture
def client(monkeypatch):
    client = ApiLensClient(
        ApiLensConfig(api_key="test-key", max_queue_size=10_000, max_queue_bytes=64 * 1024 * 1024),
        start_worker=False,
    )
    monkeypatch.setattr(spans, "_recorder", None)
    spans.configure_spans(client, app_id="orders", instrument_http=False, instrument_db=False)
    yield client
    spans._recorder = None


def _child(trace_id: str, parent: str) -> None:
    spans.record_span(
        name="SELECT 1",
        kind="db",
        trace_id=trace_id,
        span_id=generate_span_id(),
        parent_span_id=parent,
        duration_ms=1.0,
    )


def _queued_spans(client: ApiLensClient) -> int:
    return len(client._span_queue)


def test_cap_enforced_and_counted(client):
    assert MAX_SPANS_PER_REQUEST == 2000
    trace_id, span_id, _parent, token = begin_request_trace(None)
    try:
        for _ in range(MAX_SPANS_PER_REQUEST + 25):
            _child(trace_id, span_id)
        # The request's own server span is never capped.
        spans.record_span(
            name="GET /orders", kind="server", trace_id=trace_id, span_id=span_id,
            parent_span_id="", duration_ms=5.0,
        )
    finally:
        end_request_trace(token)

    assert _queued_spans(client) == MAX_SPANS_PER_REQUEST + 1
    assert client.drop_counts()["span_cap"] == 25
    assert client.dropped_count == 25
    assert client.heartbeat_payload("orders")["dropped"] == {"spans": {"span_cap": 25}}


def test_cap_is_per_request(client):
    for _ in range(2):
        trace_id, span_id, _parent, token = begin_request_trace(None)
        try:
            for _ in range(MAX_SPANS_PER_REQUEST):
                _child(trace_id, span_id)
        finally:
            end_request_trace(token)

    assert _queued_spans(client) == 2 * MAX_SPANS_PER_REQUEST
    assert client.drop_counts()["span_cap"] == 0


def test_held_spans_are_capped_and_counted_when_kept(client):
    trace_id, span_id, _parent, token = begin_request_trace(None)
    held = spans.hold_child_spans()
    try:
        for _ in range(MAX_SPANS_PER_REQUEST + 10):
            _child(trace_id, span_id)
        # Held spans are bounded while sample_on_response is pending.
        assert len(spans._held_spans_ctx.get().spans) == MAX_SPANS_PER_REQUEST
    finally:
        spans.release_child_spans(held, keep=True)
        end_request_trace(token)

    assert _queued_spans(client) == MAX_SPANS_PER_REQUEST
    assert client.drop_counts()["span_cap"] == 10


def test_held_spans_of_a_dropped_request_are_not_counted(client):
    trace_id, span_id, _parent, token = begin_request_trace(None)
    sampled = set_detail_sampled(False)
    held = spans.hold_child_spans()
    try:
        for _ in range(MAX_SPANS_PER_REQUEST + 10):
            _child(trace_id, span_id)
    finally:
        spans.release_child_spans(held, keep=False)
        reset_detail_sampled(sampled)
        end_request_trace(token)

    assert _queued_spans(client) == 0
    assert client.drop_counts()["span_cap"] == 0
