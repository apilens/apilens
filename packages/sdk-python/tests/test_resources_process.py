"""Process collectors (issue #1098): psutil optional, /proc fallbacks, PSS
permission errors, no fake zeros on macOS, and the per-sample cost.
"""

from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

import pytest

from apilens.client.resources import ResourceSampler, Sample
from apilens.client.resources import process as process_mod
from apilens.client.resources.cgroup import CgroupReader
from apilens.client.resources.process import ProcessCPU, ProcessMemory, ProcessPSS, load_psutil

KEY = "k"


class Ctx:
    cgroup = None
    cpu_limit = None

    def host_cores(self) -> int:
        return 4


def _fake_proc(tmp_path: Path) -> Path:
    proc = tmp_path / "proc"
    (proc / "self" / "fd").mkdir(parents=True)
    for i in range(7):
        (proc / "self" / "fd" / str(i)).write_text("")
    (proc / "self" / "statm").write_text("51200 2560 300 1 0 2000 0\n")
    (proc / "self" / "status").write_text("Name:\tpython\nThreads:\t9\n")
    (proc / "self" / "smaps_rollup").write_text(
        "00400000-7fff [rollup]\n"
        "Rss:              10240 kB\n"
        "Pss:               6144 kB\n"
        "Private_Clean:     1024 kB\n"
        "Private_Dirty:     3072 kB\n"
        "Private_Hugetlb:      0 kB\n"
    )
    return proc


def test_psutil_absent_falls_back_to_proc(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "psutil", None)
    assert load_psutil() is None
    proc = _fake_proc(tmp_path)
    mem = ProcessMemory(Ctx(), proc_root=str(proc), psutil="auto")
    assert mem._psutil is None
    sample = Sample()
    assert mem.collect(sample, 0.0)
    page = process_mod._page_size()
    assert sample.gauges["process.memory.rss"] == 2560 * page
    assert sample.gauges["process.threads"] == 9
    assert sample.gauges["process.fds"] == 7
    assert "python_threads_only" not in sample.flags


def test_psutil_absent_whole_sampler_still_works(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "psutil", None)
    s = ResourceSampler(interval=15.0)
    s.register(KEY)
    s.sample_now()
    time.sleep(0.02)
    s.sample_now()
    block = s.drain(KEY)
    assert block["process"]["cpu"]["cores_used"]["last"] >= 0
    assert s.errors == {}


def test_without_psutil_or_proc_rss_is_null_never_maxrss(tmp_path: Path, monkeypatch) -> None:
    # macOS without psutil: no /proc. ru_maxrss is the peak, never current RSS.
    monkeypatch.setitem(sys.modules, "psutil", None)
    mem = ProcessMemory(Ctx(), proc_root=str(tmp_path / "proc"), psutil="auto")
    sample = Sample()
    assert mem.collect(sample, 0.0) is False
    assert "process.memory.rss" not in sample.gauges
    assert "process.fds" not in sample.gauges
    # Threads fall back to Python's own count, flagged as such.
    assert sample.gauges["process.threads"] >= 1
    assert "python_threads_only" in sample.flags


def test_macos_path_has_no_container_numbers(tmp_path: Path) -> None:
    s = ResourceSampler(interval=15.0, root=str(tmp_path))  # an empty root: no /proc, no cgroup
    s.register(KEY)
    s.sample_now()
    s.sample_now()
    block = s.drain(KEY)
    assert "container" not in block
    assert block["limit_source"] in {"host", "vm"}
    assert not any(c.startswith("container.") for c in block["capabilities"])
    assert CgroupReader(str(tmp_path)).read_memory() is None


def test_pss_and_uss_from_smaps_rollup(tmp_path: Path) -> None:
    proc = _fake_proc(tmp_path)
    pss = ProcessPSS(Ctx(), proc_root=str(proc))
    sample = Sample()
    assert pss.collect(sample, 0.0)
    assert sample.gauges["process.memory.pss"] == 6144 * 1024
    assert sample.gauges["process.memory.uss"] == 4096 * 1024
    assert ProcessPSS.every == 60


def test_smaps_rollup_eacces_turns_pss_off_and_sampler_continues(tmp_path: Path, monkeypatch) -> None:
    proc = _fake_proc(tmp_path)
    denied = str(proc / "self" / "smaps_rollup")
    real_open = open
    opened: list[str] = []

    def fake_open(path, *args, **kwargs):
        opened.append(str(path))
        if str(path) == denied:
            raise PermissionError(13, "Permission denied", path)
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(process_mod, "open", fake_open, raising=False)
    pss = ProcessPSS(Ctx(), proc_root=str(proc))
    mem = ProcessMemory(Ctx(), proc_root=str(proc), psutil=None)
    s = ResourceSampler(collectors=[pss, mem], interval=15.0)
    s.register(KEY)
    s.sample_now()
    assert pss.denied and pss.off
    assert "process.pss" in s.disabled_collectors
    tries = opened.count(denied)
    for _ in range(3):
        s.sample_now()
    assert opened.count(denied) == tries  # never retried
    block = s.drain(KEY)
    assert block["n"] == 4
    assert "pss" not in block["process"]["memory"] and "rss" in block["process"]["memory"]
    assert s.errors == {}


def test_cpu_first_reading_is_a_baseline_not_zero() -> None:
    cpu = ProcessCPU(Ctx())
    first = Sample()
    cpu.collect(first, 10.0)
    assert first.gauges == {}
    t = time.process_time() + 0.05
    while time.process_time() < t:
        pass
    second = Sample()
    cpu.collect(second, 10.1)
    assert second.gauges["process.cpu.cores_used"] > 0
    assert second.gauges["process.cpu.pct_of_limit"] == pytest.approx(
        min(100.0, second.gauges["process.cpu.cores_used"] / 4 * 100)
    )


def test_each_sample_costs_under_a_millisecond_with_a_1gb_heap() -> None:
    import mmap

    # A 1 GiB mapping (what /proc and psutil walk) without making a CI box
    # actually commit 1 GiB, plus a real heap of small objects for the GC.
    heap = mmap.mmap(-1, 1 << 30)
    objects = [{"i": i} for i in range(200_000)]
    try:
        s = ResourceSampler(interval=15.0, capture_process_list=False)
        # PSS and pools run at most every 60 s and lazily: measure the
        # every-15-s path, the one a 1 GB heap could slow down.
        s.collectors = [c for c in s.collectors if c.name != "process.pss"]
        s.register(KEY)
        s.sample_now()
        costs = []
        for _ in range(50):
            t0 = time.perf_counter()
            s.sample_now()
            costs.append(time.perf_counter() - t0)
        assert statistics.median(costs) < 0.001, f"median sample {statistics.median(costs) * 1e6:.0f} us"
    finally:
        heap.close()
        del objects
