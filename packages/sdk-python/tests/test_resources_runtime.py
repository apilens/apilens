"""CPython GC and thread runtime metrics (issue #1101)."""

from __future__ import annotations

import gc
import sys
import time

from apilens.client.resources import ResourceSampler
from apilens.client.resources import runtime as runtime_mod
from apilens.client.resources.runtime import PythonRuntime, gil_enabled

KEY = "k"


class Ctx:
    cgroup = None
    cpu_limit = None

    def host_cores(self) -> int:
        return 1


def test_forced_collection_shows_in_deltas_and_pause_time() -> None:
    rt = PythonRuntime(Ctx())
    s = ResourceSampler(collectors=[rt], interval=15.0)
    s.register(KEY)
    try:
        s.sample_now()  # baseline of the cumulative counters
        s.drain(KEY)
        garbage = []
        for _ in range(2000):
            a: list = []
            a.append(a)  # a reference cycle only the GC can free
            garbage.append(a)
        del garbage, a
        gc.collect()
        gc.collect(0)
        s.sample_now()
        block = s.drain(KEY)
    finally:
        rt.stop()
    py = block["runtime"]["python"]
    gen2 = next(g for g in py["gc"] if g["generation"] == 2)
    assert gen2["collections"] >= 1
    assert sum(g.get("collected", 0) for g in py["gc"]) >= 2000
    assert gen2["pause_ms_sum"] > 0
    assert gen2["pause_ms_max"] > 0
    assert gen2["pause_ms_max"] <= gen2["pause_ms_sum"]
    assert py["threads"]["last"] >= 1
    assert py["gil_enabled"] is gil_enabled()
    assert "runtime.python" in block["capabilities"]


def test_gc_callback_is_installed_once_and_removed() -> None:
    base = runtime_mod._installed[0]  # samplers of earlier tests may hold it
    a, b = PythonRuntime(Ctx()), PythonRuntime(Ctx())
    a.start()
    b.start()
    assert gc.callbacks.count(runtime_mod._gc_callback) == 1
    a.stop()
    assert runtime_mod._gc_callback in gc.callbacks
    b.stop()
    assert runtime_mod._installed[0] == base
    assert (runtime_mod._gc_callback in gc.callbacks) is (base > 0)


def test_gc_callback_costs_under_2us_per_collection() -> None:
    cb = runtime_mod._gc_callback
    info = {"generation": 0, "collected": 0, "uncollectable": 0}
    n = 20000
    best = float("inf")
    for _ in range(5):
        t0 = time.perf_counter()
        for _ in range(n):
            cb("start", info)
            cb("stop", info)
        best = min(best, (time.perf_counter() - t0) / n)
    runtime_mod.take_pauses()
    assert best < 2e-6, f"{best * 1e6:.2f} us per collection"


def test_gil_label() -> None:
    probe = getattr(sys, "_is_gil_enabled", None)
    assert gil_enabled() is (True if probe is None else bool(probe()))
