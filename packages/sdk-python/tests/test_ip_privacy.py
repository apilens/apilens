"""Client IP privacy — ``capture_ip`` / ``anonymize_ip`` (issue #519)."""

from __future__ import annotations

import time

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client._capture import (
    CaptureContext,
    _extract_ip,
    anonymize_ip,
    apply_ip_policy,
    capture_response,
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("APILENS_CAPTURE_IP", raising=False)
    monkeypatch.delenv("APILENS_ANONYMIZE_IP", raising=False)


# ── anonymize_ip ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("203.0.113.42", "203.0.113.0"),
        ("10.1.2.255", "10.1.2.0"),
        ("203.0.113.0", "203.0.113.0"),  # already truncated
        (" 198.51.100.7 ", "198.51.100.0"),
        ("198.51.100.7:51234", "198.51.100.0"),  # with port
    ],
)
def test_anonymize_ipv4_zeroes_last_octet(raw, expected):
    assert anonymize_ip(raw) == expected


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("2001:db8:85a3:8d3:1319:8a2e:370:7348", "2001:db8:85a3::"),
        ("2001:0db8:85a3:ffff::1", "2001:db8:85a3::"),
        ("::1", "::"),
        ("[2001:db8:abcd:12::1]:443", "2001:db8:abcd::"),  # bracketed with port
        ("fe80::1:2:3:4%eth0", "fe80::"),  # zone id
        ("::ffff:203.0.113.42", "203.0.113.0"),  # IPv4-mapped -> IPv4 /24
    ],
)
def test_anonymize_ipv6_keeps_48_bits(raw, expected):
    assert anonymize_ip(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "unknown", "not-an-ip", "300.1.2.3", "1.2.3", "2001:db8::zz", "[2001:db8::1", "_hidden"],
)
def test_anonymize_invalid_strings_are_dropped(raw):
    assert anonymize_ip(raw) == ""


def test_anonymize_takes_first_entry_of_forwarded_list():
    assert anonymize_ip("203.0.113.42, 10.0.0.1, 10.0.0.2") == "203.0.113.0"
    assert anonymize_ip("2001:db8:1:2::9, 203.0.113.42") == "2001:db8:1::"


# ── X-Forwarded-For extraction + policy ─────────────────────────────────────


def test_xff_list_first_hop_then_anonymised():
    headers = {"x-forwarded-for": "203.0.113.42, 70.41.3.18, 150.172.238.178"}
    ip = _extract_ip(headers, fallback="127.0.0.1")
    assert ip == "203.0.113.42"
    assert apply_ip_policy(ip, anonymize=True) == "203.0.113.0"


def test_xff_ipv6_list_anonymised():
    headers = {"x-forwarded-for": "2001:db8:cafe:1::5, 10.0.0.1"}
    assert apply_ip_policy(_extract_ip(headers), anonymize=True) == "2001:db8:cafe::"


def test_policy_defaults_keep_ip_unchanged():
    assert apply_ip_policy("203.0.113.42") == "203.0.113.42"


def test_capture_ip_false_drops_ip_even_when_anonymising():
    assert apply_ip_policy("203.0.113.42", capture_ip=False) == ""
    assert apply_ip_policy("203.0.113.42", capture_ip=False, anonymize=True) == ""


def test_env_capture_ip_false_wins_over_code(monkeypatch):
    monkeypatch.setenv("APILENS_CAPTURE_IP", "false")
    assert apply_ip_policy("203.0.113.42", capture_ip=True) == ""


def test_env_anonymize_ip_true_wins_over_code(monkeypatch):
    monkeypatch.setenv("APILENS_ANONYMIZE_IP", "1")
    assert apply_ip_policy("203.0.113.42", anonymize=False) == "203.0.113.0"


def test_env_cannot_loosen_code(monkeypatch):
    monkeypatch.setenv("APILENS_CAPTURE_IP", "true")
    monkeypatch.setenv("APILENS_ANONYMIZE_IP", "false")
    assert apply_ip_policy("203.0.113.42", capture_ip=False) == ""
    assert apply_ip_policy("203.0.113.42", anonymize=True) == "203.0.113.0"


# ── Applied before the record is built ──────────────────────────────────────


def _captured_ip(**config_kwargs) -> str:
    client = ApiLensClient(ApiLensConfig(api_key="k", **config_kwargs), start_worker=False)
    ctx = CaptureContext(method="GET", path="/x", app_id="app", ip_address="203.0.113.42")
    capture_response(client, ctx, status_code=200, response_size=0, started_at=time.perf_counter())
    assert len(client._queue) == 1
    return client._queue[0].ip_address


def test_capture_response_default_records_full_ip():
    assert _captured_ip() == "203.0.113.42"


def test_capture_response_anonymize_ip():
    assert _captured_ip(anonymize_ip=True) == "203.0.113.0"


def test_capture_response_capture_ip_false():
    assert _captured_ip(capture_ip=False) == ""
