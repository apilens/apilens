"""CPython internals: GC per generation, pause time, threads, the GIL.

``gc.get_stats()`` gives cumulative collections / collected / uncollectable
per generation, sent as deltas over the window. Pause time comes from a
``gc.callbacks`` hook that times each collection between its ``start`` and
``stop`` phases (a ``perf_counter_ns`` call and a few list operations, well
under 2 µs per collection); the window carries the sum and the longest pause
per generation.

``gil_enabled`` is ``sys._is_gil_enabled()`` on free-threaded builds (3.13t
and later) and ``True`` before it existed.
"""

from __future__ import annotations

import gc
import sys
import threading
import time

from ._window import Sample

GENERATIONS = 3

_perf_ns = time.perf_counter_ns
# Per generation: [pause ns summed, longest pause ns] since the last sample.
# Replaced (never zeroed in place) by the collector, so a collection that
# lands while a sample is taken goes to the next one.
_pauses: list[list[int]] = [[0, 0] for _ in range(GENERATIONS)]
_gc_started = [0]
_installed = [0]
_install_lock = threading.Lock()


def _gc_callback(phase: str, info: dict) -> None:
    if phase == "start":
        _gc_started[0] = _perf_ns()
        return
    started = _gc_started[0]
    if not started:
        return
    _gc_started[0] = 0
    took = _perf_ns() - started
    gen = info.get("generation", 0)
    acc = _pauses[gen if 0 <= gen < GENERATIONS else GENERATIONS - 1]
    acc[0] += took
    if took > acc[1]:
        acc[1] = took


def install_gc_callback() -> None:
    with _install_lock:
        if _installed[0] == 0 and _gc_callback not in gc.callbacks:
            gc.callbacks.append(_gc_callback)
        _installed[0] += 1


def uninstall_gc_callback() -> None:
    with _install_lock:
        if _installed[0] == 0:
            return
        _installed[0] -= 1
        if _installed[0] == 0:
            try:
                gc.callbacks.remove(_gc_callback)
            except ValueError:
                pass


def take_pauses() -> list[tuple[int, int]]:
    """``(sum ns, max ns)`` per generation since the last call."""
    out = []
    for g in range(GENERATIONS):
        old = _pauses[g]
        _pauses[g] = [0, 0]
        out.append((old[0], old[1]))
    return out


def gil_enabled() -> bool:
    probe = getattr(sys, "_is_gil_enabled", None)
    if probe is None:
        return True
    try:
        return bool(probe())
    except Exception:
        return True


class PythonRuntime:
    """``runtime``: GC per generation and Python threads."""

    name = "runtime"
    capability = "runtime.python"
    every = 0.0
    expensive = False

    def __init__(self, ctx) -> None:
        self.ctx = ctx
        self._gil = gil_enabled()
        self._hooked = False

    def start(self) -> None:
        if not self._hooked:
            install_gc_callback()
            self._hooked = True

    def stop(self) -> None:
        if self._hooked:
            uninstall_gc_callback()
            self._hooked = False

    def reset(self) -> None:
        take_pauses()  # the parent's pauses are not the child's

    def collect(self, sample: Sample, now: float) -> bool:
        self.start()
        stats = gc.get_stats()
        n = min(len(stats), GENERATIONS)
        sample.value("runtime.gc.generations", n)
        for g in range(n):
            for field in ("collections", "collected", "uncollectable"):
                sample.counter(f"runtime.gc.{g}.{field}", stats[g].get(field))
        for g, (total, longest) in enumerate(take_pauses()[:n]):
            sample.add(f"runtime.gc.{g}.pause_ms_sum", total / 1e6)
            sample.peak(f"runtime.gc.{g}.pause_ms_max", longest / 1e6)
        sample.gauge("runtime.threads", threading.active_count())
        sample.value("runtime.gil_enabled", self._gil)
        return True


__all__ = [
    "PythonRuntime",
    "gil_enabled",
    "install_gc_callback",
    "take_pauses",
    "uninstall_gc_callback",
]
