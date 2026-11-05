"""Masking and capture options, end to end on both middlewares (issue #526).

One positive (the option masks / drops / keeps what it promises) and one
negative (without it, or for a non-matching name, the value is untouched)
case per option: ``redact_query_params``, ``redact_headers``,
``redact_body_fields``, ``mask_request_body`` / ``mask_response_body``,
``capture_content_types``, ``capture_headers``, ``capture_payloads``,
``log_request_body`` / ``log_response_body``, ``max_payload_bytes``,
``enable_request_logging``, ``capture_profile``, ``capture_ip`` and
``anonymize_ip``. Masking order is callback -> regex fields -> built-ins, and
the built-ins can never be removed. Unit-level coverage lives in
test_default_masking.py, test_body_mask_callbacks.py,
test_content_type_capture.py, test_capture_profile.py and test_ip_privacy.py.
"""

from __future__ import annotations

import json

import pytest

from apilens.client._sanitize import MASKED, REDACTED

JSON = {"Content-Type": "application/json"}


@pytest.fixture(autouse=True)
def _env(clean_apilens_env):
    pass


def _only(client) -> dict:
    assert len(client.records) == 1
    return client.records[0]


def _headers(record: dict, key: str) -> dict:
    return json.loads(record[key])


# ── redact_query_params ─────────────────────────────────────────────────────


def test_redact_query_params_masks_matching_names(harness):
    record = _only(harness.request(query="account=4711&q=shoes", redact_query_params=[r"^account$"])[0])
    assert record["raw_path"] == f"/orders?account={REDACTED}&q=shoes"


def test_query_params_untouched_without_pattern(harness):
    record = _only(harness.request(query="account=4711&q=shoes")[0])
    assert record["raw_path"] == "/orders?account=4711&q=shoes"


def test_builtin_query_masking_cannot_be_removed(harness):
    record = _only(harness.request(query="api_key=k1&q=1", redact_query_params=[])[0])
    assert record["raw_path"] == f"/orders?api_key={REDACTED}&q=1"


# ── redact_headers ──────────────────────────────────────────────────────────


def test_redact_headers_masks_matching_names(harness):
    record = _only(harness.request(headers={"X-Tenant-Id": "acme"}, redact_headers=[r"^x-tenant"])[0])
    assert _headers(record, "request_headers")["x-tenant-id"] == REDACTED


def test_headers_untouched_without_pattern(harness):
    record = _only(harness.request(headers={"X-Tenant-Id": "acme"})[0])
    assert _headers(record, "request_headers")["x-tenant-id"] == "acme"


def test_builtin_header_masking_cannot_be_removed(harness):
    record = _only(harness.request(headers={"Authorization": "Bearer abc"}, redact_headers=[])[0])
    assert _headers(record, "request_headers")["authorization"] == REDACTED


# ── redact_body_fields ──────────────────────────────────────────────────────


def test_redact_body_fields_masks_request_and_response(harness):
    client, _ = harness.request(
        method="POST",
        headers=JSON,
        body=b'{"email":"ada@example.com","n":1}',
        response_body=b'{"email":"ada@example.com","id":7}',
        redact_body_fields=[r"^email$"],
    )
    record = _only(client)
    assert json.loads(record["request_payload"]) == {"email": REDACTED, "n": 1}
    assert json.loads(record["response_payload"]) == {"email": REDACTED, "id": 7}


def test_body_fields_untouched_without_pattern(harness):
    client, _ = harness.request(method="POST", headers=JSON, body=b'{"email":"ada@example.com"}')
    assert json.loads(_only(client)["request_payload"]) == {"email": "ada@example.com"}


def test_builtin_body_masking_cannot_be_removed(harness):
    client, _ = harness.request(method="POST", headers=JSON, body=b'{"password":"p","n":1}', redact_body_fields=[])
    assert json.loads(_only(client)["request_payload"]) == {"password": REDACTED, "n": 1}


# ── mask_request_body / mask_response_body ──────────────────────────────────


def test_body_callbacks_run_first_then_regex_then_builtins(harness):
    def mask_req(info, body):
        return body.replace(b"ada", b"***")

    def mask_res(info, body):
        return b'{"email":"x@example.com","password":"leak","id":7}'

    client, out = harness.request(
        method="POST",
        headers=JSON,
        body=b'{"name":"ada"}',
        mask_request_body=mask_req,
        mask_response_body=mask_res,
        redact_body_fields=[r"^email$"],
    )
    record = _only(client)
    assert json.loads(record["request_payload"]) == {"name": "***"}
    assert json.loads(record["response_payload"]) == {"email": REDACTED, "password": REDACTED, "id": 7}
    # Masking only touches the captured copy.
    assert out == b'{"ok":true}'


def test_body_callback_returning_none_masks_the_whole_body(harness):
    client, _ = harness.request(
        method="POST",
        headers=JSON,
        body=b'{"name":"ada"}',
        mask_request_body=lambda info, body: None,
        mask_response_body=lambda info, body: None,
    )
    record = _only(client)
    assert record["request_payload"] == MASKED and record["response_payload"] == MASKED


def test_bodies_untouched_without_callbacks(harness):
    client, _ = harness.request(method="POST", headers=JSON, body=b'{"name":"ada"}')
    record = _only(client)
    assert json.loads(record["request_payload"]) == {"name": "ada"}
    assert json.loads(record["response_payload"]) == {"ok": True}


# ── capture_content_types ───────────────────────────────────────────────────


def test_default_content_types_omit_binary_bodies(harness):
    client, _ = harness.request(response_body=b"\x89PNG....", response_content_type="image/png")
    assert _only(client)["response_payload"] == "[image/png, 8 bytes omitted]"


def test_capture_content_types_opts_a_type_in(harness):
    client, _ = harness.request(
        response_body=b"<ok/>", response_content_type="application/xml", capture_content_types=["application/xml"]
    )
    assert _only(client)["response_payload"] == "<ok/>"


def test_capture_content_types_replaces_the_defaults(harness):
    client, _ = harness.request(capture_content_types=["application/xml"])
    assert _only(client)["response_payload"] == "[application/json, 11 bytes omitted]"


# ── capture_headers / capture_payloads / log_*_body / max_payload_bytes ────


def test_capture_headers_on_by_default(harness):
    assert _only(harness.request(headers={"X-Req": "1"})[0])["request_headers"] != ""


def test_capture_headers_off_drops_headers(harness):
    record = _only(harness.request(headers={"X-Req": "1"}, capture_headers=False)[0])
    assert record["request_headers"] == "" and record["response_headers"] == ""


def test_capture_payloads_off_drops_bodies(harness):
    client, _ = harness.request(method="POST", headers=JSON, body=b'{"a":1}', capture_payloads=False)
    record = _only(client)
    assert record["request_payload"] == "" and record["response_payload"] == ""
    assert record["status_code"] == 200  # the base record is still sent


def test_log_request_body_off_keeps_response_body(harness):
    client, _ = harness.request(method="POST", headers=JSON, body=b'{"a":1}', log_request_body=False)
    record = _only(client)
    assert record["request_payload"] == "" and json.loads(record["response_payload"]) == {"ok": True}


def test_log_response_body_off_keeps_request_body(harness):
    client, _ = harness.request(method="POST", headers=JSON, body=b'{"a":1}', log_response_body=False)
    record = _only(client)
    assert json.loads(record["request_payload"]) == {"a": 1} and record["response_payload"] == ""


def test_max_payload_bytes_truncates(harness):
    client, _ = harness.request(response_body=b"x" * 64, response_content_type="text/plain", max_payload_bytes=16)
    assert _only(client)["response_payload"].startswith("x" * 16)
    assert "x" * 17 not in _only(client)["response_payload"]


def test_max_payload_bytes_default_keeps_small_bodies_whole(harness):
    client, _ = harness.request(response_body=b"x" * 64, response_content_type="text/plain")
    assert _only(client)["response_payload"] == "x" * 64


def test_enable_request_logging_off_keeps_only_the_base_record(harness):
    client, _ = harness.request(method="POST", headers=JSON, body=b'{"a":1}', enable_request_logging=False)
    record = _only(client)
    assert record["request_headers"] == "" and record["request_payload"] == "" and record["response_payload"] == ""
    assert record["method"] == "POST" and record["status_code"] == 200


# ── capture_profile ─────────────────────────────────────────────────────────


def test_capture_profile_metadata_drops_headers_and_bodies(harness):
    client, _ = harness.request(method="POST", headers=JSON, body=b'{"a":1}', capture_profile="metadata")
    record = _only(client)
    assert record["request_headers"] == "" and record["request_payload"] == "" and record["response_payload"] == ""


def test_capture_profile_explicit_flag_wins(harness):
    client, _ = harness.request(
        method="POST", headers=JSON, body=b'{"a":1}', capture_profile="metadata", log_response_body=True
    )
    assert json.loads(_only(client)["response_payload"]) == {"ok": True}


# ── capture_ip / anonymize_ip (client config, applied before the record) ────


def test_ip_captured_by_default(harness, make_stub_client):
    client, _ = harness.request(client=make_stub_client(capture_ip=True, anonymize_ip=False))
    assert _only(client)["ip_address"] == "203.0.113.42"


def test_anonymize_ip_truncates(harness, make_stub_client):
    client, _ = harness.request(client=make_stub_client(capture_ip=True, anonymize_ip=True))
    assert _only(client)["ip_address"] == "203.0.113.0"


def test_capture_ip_false_sends_no_ip(harness, make_stub_client):
    client, _ = harness.request(client=make_stub_client(capture_ip=False, anonymize_ip=False))
    assert _only(client)["ip_address"] == ""
