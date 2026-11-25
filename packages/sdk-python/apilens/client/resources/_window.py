"""One sample and the window of samples a heartbeat drains (contract v1).

A collector writes into a :class:`Sample`; the sampler merges each sample
into every open :class:`Window` and :func:`compose` turns a window into the
heartbeat's ``resources`` block (``testdata/resources/heartbeat_v1.json``).

Value kinds:

* gauge: ``{min, avg, max, last}`` over the window's samples;
* counter: a raw cumulative value; the sampler turns consecutive readings into
  deltas and the window sums them. A counter that went backwards (a reset)
  is re-baselined, never reported negative;
* sum / peak: per-sample amounts the window adds up, or keeps the highest of
  (GC pause time);
* value: the latest scalar (a limit, a flag such as ``gil_enabled``);
* items: the latest list (processes, pool descriptions).

Nothing is ever filled in: a value no collector measured is absent from the
block, which the edge reads as "could not measure" (null), never 0.
"""

from __future__ import annotations

import math
from typing import Any, Hashable

#: Contract version of the ``resources`` block.
RESOURCES_VERSION = 1


def _finite(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


class Sample:
    """What the collectors measured at one instant."""

    __slots__ = ("gauges", "counters", "sums", "peaks", "values", "items", "flags", "frozen")

    def __init__(self, *, frozen: bool = False) -> None:
        self.gauges: dict[Hashable, float] = {}
        self.counters: dict[Hashable, float] = {}
        self.sums: dict[Hashable, float] = {}
        self.peaks: dict[Hashable, float] = {}
        self.values: dict[Hashable, Any] = {}
        self.items: dict[Hashable, list] = {}
        self.flags: set[str] = set()
        # True when the wall clock jumped past 2x the interval since the last
        # sample (a serverless freeze): rate collectors re-baseline and emit
        # nothing, so the window never carries a diluted CPU figure.
        self.frozen = frozen

    def gauge(self, key: Hashable, value: Any) -> None:
        if _finite(value) and value >= 0:
            self.gauges[key] = float(value)

    def counter(self, key: Hashable, raw: Any) -> None:
        if _finite(raw) and raw >= 0:
            self.counters[key] = float(raw)

    def add(self, key: Hashable, value: Any) -> None:
        if _finite(value) and value >= 0:
            self.sums[key] = self.sums.get(key, 0.0) + float(value)

    def peak(self, key: Hashable, value: Any) -> None:
        if _finite(value) and value >= 0:
            self.peaks[key] = max(self.peaks.get(key, 0.0), float(value))

    def value(self, key: Hashable, value: Any) -> None:
        if value is None:
            return
        if isinstance(value, (int, float)) and not isinstance(value, bool) and not _finite(value):
            return
        self.values[key] = value

    def set_items(self, key: Hashable, items: list) -> None:
        self.items[key] = items

    def flag(self, name: str) -> None:
        self.flags.add(name)


class Window:
    """The aggregate of the samples since the last drain."""

    __slots__ = (
        "started",
        "n",
        "gauges",
        "sums",
        "peaks",
        "values",
        "items",
        "flags",
        "cost_us",
        "cost_n",
    )

    def __init__(self, started: float) -> None:
        self.started = started
        self.n = 0
        # key -> [min, sum, max, last, count]
        self.gauges: dict[Hashable, list[float]] = {}
        self.sums: dict[Hashable, float] = {}
        self.peaks: dict[Hashable, float] = {}
        self.values: dict[Hashable, Any] = {}
        self.items: dict[Hashable, list] = {}
        self.flags: set[str] = set()
        self.cost_us = 0.0
        self.cost_n = 0

    def merge(self, sample: Sample, deltas: dict[Hashable, float], cost_us: float | None) -> None:
        self.n += 1
        for key, v in sample.gauges.items():
            g = self.gauges.get(key)
            if g is None:
                self.gauges[key] = [v, v, v, v, 1.0]
            else:
                if v < g[0]:
                    g[0] = v
                g[1] += v
                if v > g[2]:
                    g[2] = v
                g[3] = v
                g[4] += 1
        for source in (deltas, sample.sums):
            for key, v in source.items():
                self.sums[key] = self.sums.get(key, 0.0) + v
        for key, v in sample.peaks.items():
            if v > self.peaks.get(key, -1.0):
                self.peaks[key] = v
        self.values.update(sample.values)
        self.items.update(sample.items)
        self.flags |= sample.flags
        if cost_us is not None:
            self.cost_us += cost_us
            self.cost_n += 1

    def flag(self, name: str) -> None:
        self.flags.add(name)


def _num(v: float) -> float | int:
    if abs(v) >= 1000 or float(v).is_integer():
        return int(round(v))
    return round(v, 4)


def _gauge(w: Window, key: Hashable) -> dict | None:
    g = w.gauges.get(key)
    if g is None:
        return None
    return {"min": _num(g[0]), "avg": _num(g[1] / g[4]), "max": _num(g[2]), "last": _num(g[3])}


def _put(out: dict, key: str, value: Any) -> None:
    if value is None or value == {} or value == []:
        return
    out[key] = value


def _sum(w: Window, key: Hashable) -> float | int | None:
    v = w.sums.get(key)
    return None if v is None else _num(v)


def compose(
    w: Window,
    now: float,
    *,
    capabilities: list[str],
    limit_source: str,
    container_id: str = "",
) -> dict | None:
    """The ``resources`` block of window ``w``, or ``None`` when it holds no
    sample (the heartbeat then carries no block at all)."""
    if w.n == 0:
        return None
    block: dict[str, Any] = {
        "v": RESOURCES_VERSION,
        "window_s": round(max(0.0, now - w.started), 3),
        "n": w.n,
    }
    if w.cost_n:
        block["sampler_cost_us"] = round(w.cost_us / w.cost_n, 1)
    block["capabilities"] = list(capabilities)
    if limit_source:
        block["limit_source"] = limit_source

    process: dict[str, Any] = {}
    cpu: dict[str, Any] = {}
    _put(cpu, "cores_used", _gauge(w, "process.cpu.cores_used"))
    _put(cpu, "pct_of_limit", _gauge(w, "process.cpu.pct_of_limit"))
    _put(process, "cpu", cpu)
    mem: dict[str, Any] = {}
    for name in ("rss", "pss", "uss"):
        _put(mem, name, _gauge(w, f"process.memory.{name}"))
    _put(process, "memory", mem)
    _put(process, "threads", _gauge(w, "process.threads"))
    _put(process, "fds", _gauge(w, "process.fds"))
    _put(block, "process", process)

    container: dict[str, Any] = {}
    ccpu: dict[str, Any] = {}
    _put(ccpu, "cores_used", _gauge(w, "container.cpu.cores_used"))
    _put(ccpu, "pct_of_limit", _gauge(w, "container.cpu.pct_of_limit"))
    limit_cores = w.values.get("container.cpu.limit_cores")
    if limit_cores is not None:
        ccpu["limit_cores"] = _num(limit_cores)
    periods = w.sums.get("container.cpu.nr_periods")
    throttled = w.sums.get("container.cpu.nr_throttled")
    if periods is not None and throttled is not None:
        # No CFS period elapsed: nothing could be throttled (a measured 0).
        ratio = min(1.0, throttled / periods) if periods > 0 else 0.0
        ccpu["throttled_ratio"] = round(ratio, 4)
    _put(ccpu, "throttled_us", _sum(w, "container.cpu.throttled_us"))
    _put(container, "cpu", ccpu)
    cmem: dict[str, Any] = {}
    for name in ("current", "working_set", "anon", "file", "swap"):
        _put(cmem, name, _gauge(w, f"container.memory.{name}"))
    limit = w.values.get("container.memory.limit")
    if limit is not None:
        cmem["limit"] = _num(limit)
    _put(cmem, "oom_kill", _sum(w, "container.memory.oom_kill"))
    _put(container, "memory", cmem)
    if container:
        if container_id:
            container = {"container_id": container_id, **container}
        block["container"] = container

    python: dict[str, Any] = {}
    gens = w.values.get("runtime.gc.generations")
    if gens:
        gc_out = []
        for g in range(min(int(gens), 3)):
            entry: dict[str, Any] = {"generation": g}
            for name in ("collections", "collected", "uncollectable", "pause_ms_sum"):
                _put(entry, name, _sum(w, f"runtime.gc.{g}.{name}"))
            pmax = w.peaks.get(f"runtime.gc.{g}.pause_ms_max")
            if pmax is not None:
                entry["pause_ms_max"] = _num(pmax)
            if len(entry) > 1:
                gc_out.append(entry)
        _put(python, "gc", gc_out)
    _put(python, "threads", _gauge(w, "runtime.threads"))
    gil = w.values.get("runtime.gil_enabled")
    if isinstance(gil, bool):
        python["gil_enabled"] = gil
    if python:
        block["runtime"] = {"python": python}

    pools = []
    for meta in w.items.get("pools", [])[:10]:
        name = meta["name"]
        pool: dict[str, Any] = {"name": name, "kind": meta.get("kind", "")}
        _put(pool, "used", _gauge(w, ("pool", name, "used")))
        for field in ("idle", "max"):
            if meta.get(field) is not None:
                pool[field] = _num(meta[field])
        _put(pool, "pending", _gauge(w, ("pool", name, "pending")))
        pools.append(pool)
    _put(block, "pools", pools)

    _put(block, "processes", list(w.items.get("processes", []))[:20])
    block["flags"] = sorted(w.flags)[:16]
    return block


__all__ = ["RESOURCES_VERSION", "Sample", "Window", "compose"]
