"""Exclusion options, end to end on both middlewares (issue #526).

One positive (the request is excluded) and one negative (it is captured)
case per option: ``exclude_paths``, ``exclude_user_agents``,
``default_exclusions`` and their ``APILENS_*`` env vars. Unit-level coverage
of the matchers lives in test_exclude_paths.py / test_default_exclusions.py.
"""

from __future__ import annotations

import re

import pytest


@pytest.fixture(autouse=True)
def _env(clean_apilens_env):
    pass


def _assert_excluded(harness, client, out: bytes) -> None:
    assert client.records == [] and client.spans == [] and client.logs == []
    # Excluded means "not observed", never "not served".
    assert harness.app_calls == 1
    assert out == b'{"ok":true}'


# ── exclude_paths ───────────────────────────────────────────────────────────


def test_exclude_paths_skips_matching_path(harness):
    client, out = harness.request(path="/internal/metrics", exclude_paths=[r"^/internal/"], capture_spans=True)
    _assert_excluded(harness, client, out)


def test_exclude_paths_is_case_insensitive(harness):
    client, out = harness.request(path="/INTERNAL/metrics", exclude_paths=[r"^/internal/"])
    _assert_excluded(harness, client, out)


def test_exclude_paths_keeps_non_matching_path(harness):
    client, _ = harness.request(path="/orders/internal", exclude_paths=[r"^/internal/"])
    assert len(client.records) == 1


def test_exclude_paths_ignores_the_query_string(harness):
    client, _ = harness.request(path="/orders", query="next=/internal/x", exclude_paths=[r"/internal/"])
    assert len(client.records) == 1


def test_exclude_paths_env_var_adds_to_code(harness, monkeypatch):
    monkeypatch.setenv("APILENS_EXCLUDE_PATHS", r"^/from-env$")
    client, out = harness.request(path="/from-env", exclude_paths=[r"^/from-code$"])
    _assert_excluded(harness, client, out)
    client, _ = harness.request(path="/from-code", exclude_paths=[r"^/from-code$"])
    assert client.records == []
    client, _ = harness.request(path="/orders", exclude_paths=[r"^/from-code$"])
    assert len(client.records) == 1


def test_exclude_paths_invalid_regex_raises_at_construction(harness):
    with pytest.raises(re.error):
        harness.request(exclude_paths=["("])


# ── exclude_user_agents ─────────────────────────────────────────────────────


def test_exclude_user_agents_skips_matching_agent(harness):
    client, out = harness.request(headers={"User-Agent": "UptimeRobot/2.0"}, exclude_user_agents=[r"^uptimerobot"])
    _assert_excluded(harness, client, out)


def test_exclude_user_agents_keeps_other_agents(harness):
    client, _ = harness.request(headers={"User-Agent": "curl/8.4.0"}, exclude_user_agents=[r"^uptimerobot"])
    assert len(client.records) == 1
    assert client.records[0]["user_agent"] == "curl/8.4.0"


def test_exclude_user_agents_env_var_adds_to_code(harness, monkeypatch):
    monkeypatch.setenv("APILENS_EXCLUDE_USER_AGENTS", r"^pingdom")
    client, out = harness.request(headers={"User-Agent": "Pingdom.com_bot"}, exclude_user_agents=[r"^uptimerobot"])
    _assert_excluded(harness, client, out)


# ── default_exclusions ──────────────────────────────────────────────────────


@pytest.mark.parametrize("path", ["/health", "/healthz", "/ping", "/ready", "/robots.txt", "/.well-known/x"])
def test_default_exclusions_skip_health_and_housekeeping_paths(harness, path):
    client, out = harness.request(path=path)
    _assert_excluded(harness, client, out)


def test_default_exclusions_skip_probe_user_agents(harness):
    client, out = harness.request(path="/orders", headers={"User-Agent": "kube-probe/1.29"})
    _assert_excluded(harness, client, out)


def test_default_exclusions_keep_real_traffic(harness):
    client, _ = harness.request(path="/healthcare/plans", headers={"User-Agent": "Mozilla/5.0"})
    assert len(client.records) == 1


def test_default_exclusions_off_captures_probes(harness):
    client, _ = harness.request(path="/health", headers={"User-Agent": "kube-probe/1.29"}, default_exclusions=False)
    assert len(client.records) == 1
    assert client.records[0]["path"] == "/health"


def test_default_exclusions_off_keeps_user_patterns(harness):
    client, _ = harness.request(path="/internal/x", default_exclusions=False, exclude_paths=[r"^/internal/"])
    assert client.records == []


def test_default_exclusions_env_var_turns_them_off(harness, monkeypatch):
    monkeypatch.setenv("APILENS_DEFAULT_EXCLUSIONS", "false")
    client, _ = harness.request(path="/health")
    assert len(client.records) == 1
