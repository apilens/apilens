"""Processes in the SDK's own container: the top 20 by RSS, every 60 s.

Linux only (``/proc``). A process is kept only when its ``/proc/<pid>/cgroup``
equals ours, so with ``shareProcessNamespace`` or ``hostPID`` the other
containers' processes stay out. Per process: ``pid``, ``ppid``, ``comm`` (the
kernel's 15-character name), ``cpu_pct`` (percent of one core since the last
listing) and ``rss``.

Privacy: only ``/proc/<pid>/stat``, ``/proc/<pid>/comm`` and
``/proc/<pid>/cgroup`` are ever opened. Command lines, environments and
working directories are never read (argv routinely holds secrets).

When the process sees the host's PID namespace (PID 1 is ``systemd`` or
``init`` and there are more than 500 processes) the listing is turned off and
the window is flagged ``host_pid_namespace``.
"""

from __future__ import annotations

import os
from typing import Any

from ._window import Sample

PROCESS_LIST_INTERVAL_SECONDS = 60.0
MAX_PROCESSES = 20
MAX_COMM = 15
HOST_PID_THRESHOLD = 500
HOST_INITS = frozenset({"systemd", "init"})
#: The only per-process files this module ever opens.
READ_FILES = ("stat", "comm", "cgroup")


def _sysconf(name: str, default: int) -> int:
    try:
        return int(os.sysconf(name))
    except (AttributeError, ValueError, OSError):
        return default


class Processes:
    """``processes``: the container's top processes by RSS."""

    name = "processes"
    capability = "processes"
    every = PROCESS_LIST_INTERVAL_SECONDS
    expensive = True

    def __init__(self, ctx, *, proc_root: str = "/proc") -> None:
        self.ctx = ctx
        self.proc_root = proc_root
        self.supported = os.path.isdir(os.path.join(proc_root, "self"))
        self.host_pid = False
        self._tick = _sysconf("SC_CLK_TCK", 100)
        self._page = _sysconf("SC_PAGE_SIZE", 4096)
        self._prev: dict[int, tuple[float, float]] = {}  # pid -> (cpu seconds, monotonic)

    @property
    def off(self) -> bool:
        return self.host_pid or not self.supported

    def reset(self) -> None:
        self._prev = {}

    def _read(self, *parts: str) -> str | None:
        try:
            with open(os.path.join(self.proc_root, *parts), encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            return None

    def _pids(self) -> list[int]:
        try:
            return [int(d) for d in os.listdir(self.proc_root) if d.isdigit()]
        except OSError:
            return []

    def detect_host_pid_namespace(self, pids: list[int]) -> bool:
        init = (self._read("1", "comm") or "").strip()
        return init in HOST_INITS and len(pids) > HOST_PID_THRESHOLD

    def _stat(self, pid: int) -> tuple[int | None, float, float] | None:
        """``(ppid, cpu seconds, rss bytes)`` from ``/proc/<pid>/stat``."""
        text = self._read(str(pid), "stat")
        if not text:
            return None
        end = text.rfind(")")
        fields = text[end + 2 :].split() if end >= 0 else []
        if len(fields) < 22:
            return None
        try:
            ppid = int(fields[1])
            cpu = (int(fields[11]) + int(fields[12])) / self._tick
            rss = float(int(fields[21]) * self._page)
        except ValueError:
            return None
        return ppid, cpu, rss

    def list(self, now: float, *, frozen: bool = False) -> list[dict[str, Any]] | None:
        """The top processes of our cgroup, or ``None`` when listing is off."""
        if self.off:
            return None
        pids = self._pids()
        if self.detect_host_pid_namespace(pids):
            self.host_pid = True
            return None
        own = self._read("self", "cgroup")
        if own is None:
            return None
        rows: list[dict[str, Any]] = []
        seen: dict[int, tuple[float, float]] = {}
        for pid in pids:
            if self._read(str(pid), "cgroup") != own:
                continue
            stat = self._stat(pid)
            if stat is None:
                continue
            ppid, cpu, rss = stat
            comm = (self._read(str(pid), "comm") or "").strip()[:MAX_COMM]
            row: dict[str, Any] = {"pid": pid, "ppid": ppid, "comm": comm}
            prev = self._prev.get(pid)
            if prev is not None and not frozen and now > prev[1] and cpu >= prev[0]:
                row["cpu_pct"] = round((cpu - prev[0]) / (now - prev[1]) * 100, 2)
            row["rss"] = rss
            seen[pid] = (cpu, now)
            rows.append(row)
        self._prev = seen
        rows.sort(key=lambda r: r["rss"], reverse=True)
        return rows[:MAX_PROCESSES]

    def collect(self, sample: Sample, now: float) -> bool:
        rows = self.list(now, frozen=sample.frozen)
        if self.host_pid:
            sample.flag("host_pid_namespace")
        if not rows:
            return False
        for row in rows:
            row["rss"] = int(row["rss"])
        sample.set_items("processes", rows)
        return True


__all__ = ["Processes", "MAX_PROCESSES", "PROCESS_LIST_INTERVAL_SECONDS", "READ_FILES"]
