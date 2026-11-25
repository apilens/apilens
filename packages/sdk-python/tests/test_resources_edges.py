"""Serverless and multi-process framework edges (issue #1104), and
``instance_id`` on request records (issue #1105)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from datetime import datetime, timezone
from pathlib import Path

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client import client as client_mod
from apilens.client.models import RequestRecord

SDK_ROOT = Path(__file__).resolve().parents[1]


def _run(code: str, env: dict | None = None) -> dict:
    full_env = {**os.environ, "PYTHONPATH": str(SDK_ROOT), **(env or {})}
    out = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True, timeout=60, env=full_env
    )
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


# ── Django runserver ───────────────────────────────────────────────────────


def test_runserver_parent_does_not_sample(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", ["manage.py", "runserver", "0.0.0.0:8000"])
    monkeypatch.delenv("RUN_MAIN", raising=False)
    parent = ApiLensClient(ApiLensConfig(api_key="k"), start_worker=False)
    assert parent.resources is None

    monkeypatch.setenv("RUN_MAIN", "true")  # the autoreloader's child serves requests
    child = ApiLensClient(ApiLensConfig(api_key="k"), start_worker=False)
    assert child.resources is not None

    monkeypatch.delenv("RUN_MAIN")
    monkeypatch.setattr(sys, "argv", ["manage.py", "runserver", "--noreload"])
    assert ApiLensClient(ApiLensConfig(api_key="k"), start_worker=False).resources is not None
    monkeypatch.setattr(sys, "argv", ["gunicorn", "app:app"])
    assert ApiLensClient(ApiLensConfig(api_key="k"), start_worker=False).resources is not None


def test_autoreload_parent_detection(monkeypatch) -> None:
    monkeypatch.delenv("RUN_MAIN", raising=False)
    monkeypatch.setattr(sys, "argv", ["manage.py", "runserver"])
    assert client_mod._django_autoreload_parent()
    monkeypatch.setattr(sys, "argv", ["manage.py", "migrate"])
    assert not client_mod._django_autoreload_parent()


# ── gunicorn --preload: PSS < RSS ───────────────────────────────────────────


@pytest.mark.skipif(not os.path.exists("/proc/self/smaps_rollup"), reason="PSS needs Linux smaps_rollup")
def test_preloaded_worker_pss_is_below_rss() -> None:
    result = _run(
        """
        import json, os
        from apilens.client.resources.process import ProcessMemory, ProcessPSS
        # The "preload": a big heap built in the master before forking workers.
        preloaded = [bytes([i % 256]) * 4096 for i in range(50000)]  # ~200 MB
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(r)
            pss, uss = ProcessPSS(None).read()
            rss = ProcessMemory(None, psutil=None).rss()
            os.write(w, json.dumps({"pss": pss, "uss": uss, "rss": rss}).encode())
            os._exit(0)
        os.close(w)
        data = os.read(r, 4096)
        os.waitpid(pid, 0)
        print(data.decode())
        """
    )
    assert result["pss"] < result["rss"]
    assert result["uss"] < result["pss"]


# ── instance_id on request records ─────────────────────────────────────────


def _record() -> RequestRecord:
    return RequestRecord(
        timestamp=datetime.now(tz=timezone.utc),
        environment="production",
        method="GET",
        path="/orders",
        status_code=200,
        response_time_ms=3.0,
        app_id="orders-api",
    )


def test_records_carry_the_current_instance_id() -> None:
    client = ApiLensClient(ApiLensConfig(api_key="k"), start_worker=False)
    client.capture(method="GET", path="/a", status_code=200, response_time_ms=1.0, app_id="orders-api")
    record = _record()
    client.capture_record(record)
    queued = list(client._queue)
    assert [r.instance_id for r in queued] == [client.instance_id, client.instance_id]
    assert queued[0].to_wire()["instance_id"] == client.instance_id


def test_unstamped_record_wire_has_no_instance_id() -> None:
    assert "instance_id" not in _record().to_wire()


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_forked_child_stamps_its_own_instance_id() -> None:
    result = _run(
        """
        import json, os
        from datetime import datetime, timezone
        from apilens.client import ApiLensClient, ApiLensConfig
        c = ApiLensClient(ApiLensConfig(api_key="k", send_heartbeat=False), start_worker=False)
        def capture():
            c.capture(method="GET", path="/a", status_code=200, response_time_ms=1.0, app_id="a")
            return c._queue.pop().to_wire()["instance_id"]
        parent = capture()
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.write(w, json.dumps({"child": capture(), "child_id": c.instance_id}).encode())
            os._exit(0)
        os.close(w)
        out = json.loads(os.read(r, 4096))
        os.waitpid(pid, 0)
        out["parent"] = parent
        out["parent_id"] = c.instance_id
        print(json.dumps(out))
        """
    )
    assert result["parent"] == result["parent_id"]
    assert result["child"] == result["child_id"]
    assert result["child"] != result["parent"]
