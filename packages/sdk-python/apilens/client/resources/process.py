"""The SDK process itself: CPU, RSS, PSS/USS, threads and open files.

psutil is optional (``pip install apilenss[resources]``). Without it the
collectors read ``/proc/self`` on Linux and fall back to the standard library
elsewhere, with fewer fields: on macOS without psutil there is no current RSS
(``ru_maxrss`` is the *peak*, so it is never reported as current) and no fd
count. A field that cannot be measured is left out, never sent as 0.

* CPU: ``time.process_time()`` deltas over monotonic wall time. No psutil
  needed, and unlike ``psutil.cpu_percent()`` the first reading is a baseline,
  not a bogus 0.
* RSS: psutil, else ``/proc/self/statm``.
* PSS/USS: ``/proc/self/smaps_rollup`` every 60 s, Linux only. The first
  permission error turns it off for the life of the process.
* Threads: psutil, else ``/proc/self/status``, else ``threading.active_count()``
  flagged ``python_threads_only``.
* fds: ``/proc/self/fd``, else psutil.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Any

from ._window import Sample

PSS_INTERVAL_SECONDS = 60.0


def load_psutil() -> Any:
    """The psutil module, or ``None`` when it is not installed (or blocked
    with ``sys.modules['psutil'] = None``)."""
    try:
        import psutil  # type: ignore[import-not-found]
    except Exception:
        return None
    return psutil


def _page_size() -> int:
    try:
        return os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, ValueError, OSError):
        return 4096


class ProcessCPU:
    """``process.cpu``: cores this process keeps busy, and that as a percent
    of the effective limit (cgroup quota, affinity, cpuset, else host cores)."""

    name = "process.cpu"
    capability = "process.cpu"
    every = 0.0
    expensive = False

    def __init__(self, ctx) -> None:
        self.ctx = ctx
        self._prev: tuple[float, float] | None = None

    def reset(self) -> None:
        self._prev = None

    def collect(self, sample: Sample, now: float) -> bool:
        cpu = time.process_time()
        prev, self._prev = self._prev, (cpu, now)
        if prev is None or sample.frozen or now <= prev[1] or cpu < prev[0]:
            return True  # a baseline (first sample, after fork or a freeze)
        cores = (cpu - prev[0]) / (now - prev[1])
        sample.gauge("process.cpu.cores_used", cores)
        base = self.ctx.cpu_limit or self.ctx.host_cores()
        if base:
            sample.gauge("process.cpu.pct_of_limit", min(100.0, cores / base * 100))
        return True


class ProcessMemory:
    """``process.memory``: RSS, OS threads and open file descriptors."""

    name = "process.memory"
    capability = "process.memory"
    every = 0.0
    expensive = False

    def __init__(self, ctx, *, proc_root: str = "/proc", psutil: Any = "auto") -> None:
        self.ctx = ctx
        self.proc_root = proc_root
        self._psutil = load_psutil() if psutil == "auto" else psutil
        self._proc = None
        self._page = _page_size()
        self._linux = os.path.isdir(os.path.join(proc_root, "self"))

    def reset(self) -> None:
        self._proc = None  # psutil.Process caches the pid

    def _process(self):
        if self._psutil is None:
            return None
        if self._proc is None or self._proc.pid != os.getpid():
            self._proc = self._psutil.Process()
        return self._proc

    def rss(self) -> float | None:
        proc = self._process()
        if proc is not None:
            try:
                return float(proc.memory_info().rss)
            except Exception:
                pass
        if self._linux:
            try:
                with open(os.path.join(self.proc_root, "self", "statm"), "rb") as f:
                    return float(int(f.read().split()[1]) * self._page)
            except (OSError, IndexError, ValueError):
                pass
        return None

    def threads(self) -> tuple[float | None, bool]:
        proc = self._process()
        if proc is not None:
            try:
                return float(proc.num_threads()), False
            except Exception:
                pass
        if self._linux:
            try:
                with open(os.path.join(self.proc_root, "self", "status"), "rb") as f:
                    for line in f:
                        if line.startswith(b"Threads:"):
                            return float(int(line.split()[1])), False
            except (OSError, IndexError, ValueError):
                pass
        return float(threading.active_count()), True

    def fds(self) -> float | None:
        if self._linux:
            try:
                return float(len(os.listdir(os.path.join(self.proc_root, "self", "fd"))))
            except OSError:
                pass
        proc = self._process()
        if proc is not None and hasattr(proc, "num_fds"):
            try:
                return float(proc.num_fds())
            except Exception:
                pass
        return None

    def collect(self, sample: Sample, now: float) -> bool:
        rss = self.rss()
        sample.gauge("process.memory.rss", rss)
        threads, python_only = self.threads()
        sample.gauge("process.threads", threads)
        if python_only:
            sample.flag("python_threads_only")
        sample.gauge("process.fds", self.fds())
        return rss is not None


class ProcessPSS:
    """``process.pss``: PSS and USS from ``/proc/self/smaps_rollup`` every 60 s
    (Linux only). PSS splits shared pages between the processes sharing them,
    so pre-forked workers (gunicorn ``--preload``) show what each really costs.
    Off for good after the first EACCES."""

    name = "process.pss"
    capability = "process.pss"
    every = PSS_INTERVAL_SECONDS
    expensive = True

    def __init__(self, ctx, *, proc_root: str = "/proc") -> None:
        self.ctx = ctx
        self.path = os.path.join(proc_root, "self", "smaps_rollup")
        self.denied = False
        self.supported = sys.platform.startswith("linux") or os.path.exists(self.path)

    def reset(self) -> None:
        pass

    @property
    def off(self) -> bool:
        """True once PSS can never be read here (not Linux, or EACCES)."""
        return self.denied or not self.supported

    def read(self) -> tuple[float, float] | None:
        """``(pss, uss)`` in bytes, or ``None`` (missing or denied)."""
        if self.denied or not self.supported:
            return None
        try:
            with open(self.path, "rb") as f:
                text = f.read()
        except PermissionError:
            self.denied = True
            return None
        except OSError:
            return None
        pss = uss = None
        for line in text.splitlines():
            parts = line.split()
            if len(parts) < 2:
                continue
            key = parts[0]
            try:
                kb = int(parts[1])
            except ValueError:
                continue
            if key == b"Pss:":
                pss = kb * 1024.0
            elif key in (b"Private_Clean:", b"Private_Dirty:", b"Private_Hugetlb:"):
                uss = (uss or 0.0) + kb * 1024.0
        if pss is None:
            return None
        return pss, (uss if uss is not None else float("nan"))

    def collect(self, sample: Sample, now: float) -> bool:
        if self.denied or not self.supported:
            return False
        got = self.read()
        if got is None:
            return False
        sample.gauge("process.memory.pss", got[0])
        sample.gauge("process.memory.uss", got[1])
        return True


__all__ = ["ProcessCPU", "ProcessMemory", "ProcessPSS", "load_psutil", "PSS_INTERVAL_SECONDS"]
