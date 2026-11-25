"""DB pool metrics (issue #1102): SQLAlchemy QueuePool and Django."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from apilens.client.resources import ResourceSampler
from apilens.client.resources import pools as pools_mod
from apilens.client.resources.pools import Pools

SDK_ROOT = Path(__file__).resolve().parents[1]
KEY = "k"


def _sampler() -> ResourceSampler:
    s = ResourceSampler(collectors=[Pools(None)], interval=15.0)
    s.register(KEY)
    return s


def test_no_pool_means_no_pools_key(monkeypatch) -> None:
    monkeypatch.setattr(pools_mod, "_engines", pools_mod.weakref.WeakSet())
    monkeypatch.setattr(pools_mod, "_django_wrappers", pools_mod.weakref.WeakSet())
    s = _sampler()
    s.sample_now()
    block = s.drain(KEY)
    assert "pools" not in block
    assert "pools" not in block["capabilities"]


def test_sqlalchemy_queuepool_with_three_checked_out(tmp_path: Path, monkeypatch) -> None:
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy.pool import QueuePool

    monkeypatch.setattr(pools_mod, "_engines", pools_mod.weakref.WeakSet())
    s = _sampler()
    s.sample_now()  # hooks SQLAlchemy lazily (the app already imported it)
    engine = sqlalchemy.create_engine(
        f"sqlite:///{tmp_path / 'orders.db'}", poolclass=QueuePool, pool_size=5, max_overflow=2
    )
    conns = [engine.connect() for _ in range(3)]  # engine_connect registers the engine
    try:
        s.sample_now()
        block = s.drain(KEY)
    finally:
        for c in conns:
            c.close()
        engine.dispose()
    pool = block["pools"][0]
    assert pool["name"] == "orders.db" and pool["kind"] == "sqlalchemy"
    assert pool["used"]["last"] == 3
    assert pool["max"] == 7
    assert pool["idle"] == 0
    assert pool["pending"]["last"] == 0
    assert "pools" in block["capabilities"]


def test_django_open_connections_per_alias(tmp_path: Path) -> None:
    pytest.importorskip("django")
    code = f"""
        import json, threading
        import django
        from django.conf import settings
        settings.configure(DATABASES={{
            "default": {{"ENGINE": "django.db.backends.sqlite3", "NAME": {str(tmp_path / 'a.db')!r}}},
            "replica": {{"ENGINE": "django.db.backends.sqlite3", "NAME": {str(tmp_path / 'b.db')!r}}},
        }})
        django.setup()
        from django.db import connections
        from apilens.client.resources import ResourceSampler
        from apilens.client.resources.pools import Pools
        s = ResourceSampler(collectors=[Pools(None)], interval=15.0)
        s.register("k")
        s.sample_now()  # hooks connection_created lazily
        ready, done = threading.Event(), threading.Event()
        def worker():
            connections["default"].ensure_connection()
            ready.set()
            done.wait()
        t = threading.Thread(target=worker)
        t.start()
        ready.wait()
        connections["default"].ensure_connection()
        connections["replica"].ensure_connection()
        s.sample_now()
        block = s.drain("k")
        done.set()
        t.join()
        print(json.dumps(block["pools"]))
    """
    env = {**os.environ, "PYTHONPATH": str(SDK_ROOT)}
    out = subprocess.run([sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True, env=env, timeout=60)
    assert out.returncode == 0, out.stderr
    pools = {p["name"]: p for p in json.loads(out.stdout.strip().splitlines()[-1])}
    assert pools["default"]["kind"] == "django"
    assert pools["default"]["used"]["last"] == 2  # two threads, one connection each
    assert pools["replica"]["used"]["last"] == 1
