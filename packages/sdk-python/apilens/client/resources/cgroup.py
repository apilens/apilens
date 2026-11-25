"""cgroup v1 / v2 reader: the container's CPU and memory, its limits and its id.

The version is decided per controller from ``/proc/self/mountinfo`` (never by
probing files): a hybrid systemd host mounts an empty cgroup2 hierarchy next
to v1 ``cpu`` and ``memory`` controllers, and those are read as v1. The
process's own cgroup comes from ``/proc/self/cgroup`` and is resolved against
the mount's root field, so a cgroup namespace (own path ``/``) and a v1 bind
mount of the container's cgroup both land on the right directory.

Limits are the minimum over the leaf and every ancestor up to the mount
point (a Kubernetes container whose own ``memory.max`` is ``max`` is still
bound by its pod slice). "No limit" sentinels (``max``, ``-1``, cgroup v1's
page-aligned ``LONG_MAX`` and anything at or above 2^62, or above the host's
``MemTotal``) become ``None``.

Every file is read on its own: one that is missing or unreadable (EACCES)
leaves that one field ``None`` and the others intact. ``root`` is injectable so
tests point it at a fake sysfs tree (``testdata/cgroup/<case>/root``), shared
with the TypeScript and Java readers.
"""

from __future__ import annotations

import os
import re
from typing import Any

from ._window import Sample

#: Values at or above this are "no limit" sentinels.
SENTINEL_MIN = 1 << 62

_HEX64 = re.compile(r"[0-9a-f]{64}")
_ECS_ID = re.compile(r"[0-9a-f]{32}-\d+")
_RUNTIME_PREFIXES = ("docker-", "cri-containerd-", "crio-", "libpod-")
_MOUNTINFO_ID = re.compile(r"containers/([0-9a-f]{64})/")


def container_id_from_cgroup_line(line: str) -> str | None:
    """The container id one ``/proc/self/cgroup`` line names, or ``None``.

    A 64-hex id, bare or with a ``docker-`` / ``cri-containerd-`` / ``crio-`` /
    ``libpod-`` prefix and ``.scope`` suffix, or an ECS ``<32hex>-<digits>``.
    ``crio-conmon-*`` is CRI-O's monitor process, never the container."""
    parts = line.strip().split(":", 2)
    path = parts[2] if len(parts) == 3 else line.strip()
    for segment in reversed([s for s in path.split("/") if s]):
        if segment.startswith("crio-conmon-"):
            return None
        if segment.endswith(".scope"):
            segment = segment[: -len(".scope")]
        for prefix in _RUNTIME_PREFIXES:
            if segment.startswith(prefix):
                segment = segment[len(prefix) :]
                break
        if _HEX64.fullmatch(segment) or _ECS_ID.fullmatch(segment):
            return segment
    return None


def container_id_from_mountinfo(text: str) -> str | None:
    """The container id in a mount source path (``.../containers/<id>/...``),
    the only place it shows under a cgroup v2 namespace. Sandbox (pause
    container) paths are not the app's container and do not match."""
    for line in text.splitlines():
        fields = line.split()
        if len(fields) > 3:
            m = _MOUNTINFO_ID.search(fields[3])
            if m:
                return m.group(1)
    return None


class _Mount:
    __slots__ = ("root", "point", "fstype", "options")

    def __init__(self, root: str, point: str, fstype: str, options: set[str]) -> None:
        self.root = root
        self.point = point
        self.fstype = fstype
        self.options = options


def _parse_mountinfo(text: str) -> list[_Mount]:
    mounts = []
    for line in text.splitlines():
        left, sep, right = line.partition(" - ")
        if not sep:
            continue
        fields = left.split()
        tail = right.split()
        if len(fields) < 5 or len(tail) < 1:
            continue
        fstype = tail[0]
        if fstype not in ("cgroup", "cgroup2"):
            continue
        options = set(tail[2].split(",")) if len(tail) > 2 else set()
        mounts.append(_Mount(_unescape(fields[3]), _unescape(fields[4]), fstype, options))
    return mounts


def _unescape(path: str) -> str:
    # mountinfo escapes space, tab, newline and backslash as \ooo.
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), path)


def _host_cores() -> int:
    try:
        return len(os.sched_getaffinity(0))  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return os.cpu_count() or 1


def _count_cpus(spec: str) -> int | None:
    """``0-3,6`` -> 5."""
    total = 0
    for part in spec.strip().split(","):
        part = part.strip()
        if not part:
            continue
        lo, _, hi = part.partition("-")
        try:
            total += (int(hi) - int(lo) + 1) if hi else 1
        except ValueError:
            return None
    return total or None


class CgroupReader:
    """Reads the cgroup the process runs in. Build once per process (again
    after fork); :meth:`read` is cheap (a handful of small files)."""

    def __init__(self, root: str = "/", *, host_cores: int | None = None) -> None:
        self.root = root
        self._host_cores = host_cores
        self.cpu_version: str | None = None  # "v1" | "v2" | None
        self.memory_version: str | None = None
        self.cpu_dir: str | None = None
        self.cpu_top: str | None = None
        self.cpuacct_dir: str | None = None
        self.cpuset_dir: str | None = None
        self.memory_dir: str | None = None
        self.memory_top: str | None = None
        self.cgroup_text = ""
        self.container_id: str | None = None
        self._mem_total: float | None = None
        self._detect()

    # ── paths ───────────────────────────────────────────────────────────

    def _path(self, path: str) -> str:
        return os.path.join(self.root, path.lstrip("/"))

    def _read(self, path: str) -> str | None:
        try:
            with open(path, encoding="ascii", errors="replace") as f:
                return f.read()
        except OSError:
            return None

    def _detect(self) -> None:
        self.cgroup_text = self._read(self._path("/proc/self/cgroup")) or ""
        mountinfo = self._read(self._path("/proc/self/mountinfo")) or ""
        mounts = _parse_mountinfo(mountinfo)
        v1_paths: dict[str, str] = {}
        v2_path: str | None = None
        for line in self.cgroup_text.splitlines():
            parts = line.strip().split(":", 2)
            if len(parts) != 3:
                continue
            hier, controllers, path = parts
            if hier == "0" and controllers == "":
                v2_path = path
            else:
                for c in controllers.split(","):
                    v1_paths[c] = path
        v2_mount = next((m for m in mounts if m.fstype == "cgroup2"), None)

        def v1(controller: str) -> tuple[str, str] | None:
            for m in mounts:
                if m.fstype == "cgroup" and controller in m.options:
                    own = v1_paths.get(controller, "/")
                    return self._resolve(m, own), self._path(m.point)
            return None

        mem = v1("memory")
        if mem is not None:
            self.memory_version, (self.memory_dir, self.memory_top) = "v1", mem
        cpu = v1("cpu")
        if cpu is not None:
            self.cpu_version, (self.cpu_dir, self.cpu_top) = "v1", cpu
            acct = v1("cpuacct")
            self.cpuacct_dir = acct[0] if acct else self.cpu_dir
        cpuset = v1("cpuset")
        if cpuset is not None:
            self.cpuset_dir = cpuset[0]
        if v2_mount is not None and v2_path is not None:
            leaf, top = self._resolve(v2_mount, v2_path), self._path(v2_mount.point)
            controllers = self._read(os.path.join(top, "cgroup.controllers"))
            # A hybrid host's cgroup2 mount has no controllers enabled at its
            # root: only take what v1 did not already provide.
            usable = controllers is None or bool(controllers.split())
            if usable:
                if self.memory_version is None:
                    self.memory_version, self.memory_dir, self.memory_top = "v2", leaf, top
                if self.cpu_version is None:
                    self.cpu_version, self.cpu_dir, self.cpu_top = "v2", leaf, top
                    self.cpuacct_dir = leaf
                if self.cpuset_dir is None:
                    self.cpuset_dir = leaf
        self.container_id = self._container_id(mountinfo)

    def _resolve(self, mount: _Mount, own: str) -> str:
        """Directory of cgroup ``own`` under ``mount``, honouring the mount's
        root field. A path outside the mount root (a cgroup namespace) is the
        mount point itself."""
        point = self._path(mount.point)
        root = mount.root.rstrip("/")
        own = own.rstrip("/")
        if own == root:
            rel = ""
        elif root == "" or own.startswith(root + "/"):
            rel = own[len(root) :]
        else:
            rel = ""
        candidate = os.path.join(point, rel.lstrip("/")) if rel else point
        return candidate if os.path.isdir(candidate) else point

    def _container_id(self, mountinfo: str) -> str | None:
        for line in self.cgroup_text.splitlines():
            cid = container_id_from_cgroup_line(line)
            if cid:
                return cid
        return container_id_from_mountinfo(mountinfo)

    def _ancestors(self, leaf: str | None, top: str | None) -> list[str]:
        """``leaf`` and its parents up to ``top`` (the mount point), leaf first."""
        if leaf is None:
            return []
        out = [leaf]
        if top is None:
            return out
        top = os.path.normpath(top)
        cur = os.path.normpath(leaf)
        while cur != top and cur.startswith(top):
            cur = os.path.dirname(cur)
            out.append(cur)
        return out

    # ── values ──────────────────────────────────────────────────────────

    @property
    def available(self) -> bool:
        return self.cpu_version is not None or self.memory_version is not None

    @property
    def limit_source(self) -> str:
        versions = {self.cpu_version, self.memory_version}
        if "v1" in versions:
            return "cgroup_v1"
        if "v2" in versions:
            return "cgroup_v2"
        return "none"

    def _int(self, path: str) -> int | None:
        text = self._read(path)
        if text is None:
            return None
        text = text.strip()
        try:
            return int(text)
        except ValueError:
            return None

    def _kv(self, path: str) -> dict[str, int] | None:
        text = self._read(path)
        if text is None:
            return None
        out: dict[str, int] = {}
        for line in text.splitlines():
            parts = line.split()
            if len(parts) == 2:
                try:
                    out[parts[0]] = int(parts[1])
                except ValueError:
                    pass
        return out

    def _mem_limit_value(self, raw: int | None) -> int | None:
        if raw is None or raw <= 0 or raw >= SENTINEL_MIN:
            return None
        total = self._memtotal()
        if total is not None and raw > total:
            return None
        return raw

    def _memtotal(self) -> float | None:
        if self._mem_total is None:
            text = self._read(self._path("/proc/meminfo")) or ""
            for line in text.splitlines():
                if line.startswith("MemTotal:"):
                    try:
                        self._mem_total = float(line.split()[1]) * 1024
                    except (IndexError, ValueError):
                        pass
                    break
            else:
                self._mem_total = -1.0
        return None if self._mem_total < 0 else self._mem_total

    def host_cores(self) -> int:
        """CPUs the process may run on: affinity (or the injected host cores),
        narrowed by the cgroup cpuset."""
        cores = self._host_cores if self._host_cores is not None else _host_cores()
        if self.cpuset_dir is not None:
            name = "cpuset.cpus.effective" if self.cpu_version == "v2" else "cpuset.effective_cpus"
            spec = self._read(os.path.join(self.cpuset_dir, name))
            if spec is None:
                spec = self._read(os.path.join(self.cpuset_dir, "cpuset.cpus"))
            n = _count_cpus(spec) if spec else None
            if n:
                cores = min(cores, n)
        return cores

    def cpu_quota_cores(self) -> float | None:
        """The CFS quota in cores, minimum over the ancestors; ``None`` without one."""
        best: float | None = None
        for d in self._ancestors(self.cpu_dir, self.cpu_top):
            q: float | None = None
            if self.cpu_version == "v2":
                text = self._read(os.path.join(d, "cpu.max"))
                if text:
                    parts = text.split()
                    if len(parts) == 2 and parts[0] != "max":
                        try:
                            quota, period = int(parts[0]), int(parts[1])
                            if quota > 0 and period > 0:
                                q = quota / period
                        except ValueError:
                            pass
            else:
                quota = self._int(os.path.join(d, "cpu.cfs_quota_us"))
                period = self._int(os.path.join(d, "cpu.cfs_period_us"))
                if quota is not None and period and quota > 0:
                    q = quota / period
            if q is not None and (best is None or q < best):
                best = q
        return best

    def limit_cores(self) -> float | None:
        """Effective CPU limit in cores: min(quota, affinity, cpuset), or
        ``None`` when there is no quota (the host's cores are not a limit)."""
        quota = self.cpu_quota_cores()
        if quota is None:
            return None
        return min(quota, float(self.host_cores()))

    def read_cpu(self) -> dict[str, Any] | None:
        if self.cpu_version is None:
            return None
        out: dict[str, Any] = {
            "limit_cores": self.limit_cores(),
            "usage_us": None,
            "nr_periods": None,
            "nr_throttled": None,
            "throttled_us": None,
        }
        stat = self._kv(os.path.join(self.cpu_dir or "", "cpu.stat"))
        if self.cpu_version == "v2":
            if stat is not None:
                out["usage_us"] = stat.get("usage_usec")
                out["throttled_us"] = stat.get("throttled_usec")
        else:
            usage_ns = self._int(os.path.join(self.cpuacct_dir or "", "cpuacct.usage"))
            if usage_ns is not None:
                out["usage_us"] = usage_ns // 1000
            if stat is not None and "throttled_time" in stat:
                out["throttled_us"] = stat["throttled_time"] // 1000
        if stat is not None:
            out["nr_periods"] = stat.get("nr_periods")
            out["nr_throttled"] = stat.get("nr_throttled")
        return out

    def memory_limit(self) -> int | None:
        best: int | None = None
        name = "memory.max" if self.memory_version == "v2" else "memory.limit_in_bytes"
        for d in self._ancestors(self.memory_dir, self.memory_top):
            text = self._read(os.path.join(d, name))
            if text is None or text.strip() == "max":
                continue
            try:
                v = self._mem_limit_value(int(text.strip()))
            except ValueError:
                continue
            if v is not None and (best is None or v < best):
                best = v
        return best

    def read_memory(self) -> dict[str, Any] | None:
        if self.memory_version is None:
            return None
        d = self.memory_dir or ""
        out: dict[str, Any] = {
            "limit": self.memory_limit(),
            "current": None,
            "working_set": None,
            "anon": None,
            "file": None,
            "swap": None,
            "oom_kill": None,
        }
        stat = self._kv(os.path.join(d, "memory.stat")) or {}
        if self.memory_version == "v2":
            current = self._int(os.path.join(d, "memory.current"))
            anon, file, inactive = stat.get("anon"), stat.get("file"), stat.get("inactive_file")
            out["swap"] = self._int(os.path.join(d, "memory.swap.current"))
            events = self._kv(os.path.join(d, "memory.events"))
            if events is not None:
                out["oom_kill"] = events.get("oom_kill")
        else:
            current = self._int(os.path.join(d, "memory.usage_in_bytes"))
            anon = stat.get("total_rss", stat.get("rss"))
            file = stat.get("total_cache", stat.get("cache"))
            inactive = stat.get("total_inactive_file", stat.get("inactive_file"))
            memsw = self._int(os.path.join(d, "memory.memsw.usage_in_bytes"))
            if memsw is not None and current is not None and memsw < SENTINEL_MIN:
                out["swap"] = max(0, memsw - current)
            oom = self._kv(os.path.join(d, "memory.oom_control"))
            if oom is not None:
                out["oom_kill"] = oom.get("oom_kill")
        out["current"] = current
        out["anon"] = anon
        out["file"] = file
        if current is not None and inactive is not None:
            out["working_set"] = max(0, current - inactive)
        return out

    def read(self) -> dict[str, Any]:
        """Everything at once, in the shape of ``testdata/cgroup/expected.json``."""
        return {
            "limit_source": self.limit_source,
            "container_id": self.container_id,
            "cpu": self.read_cpu(),
            "memory": self.read_memory(),
        }


# ── Collectors ──────────────────────────────────────────────────────────


class ContainerCPU:
    """``container.cpu``: cgroup CPU use, its limit and throttling."""

    name = "container.cpu"
    capability = "container.cpu"
    every = 0.0
    expensive = False

    def __init__(self, ctx) -> None:
        self.ctx = ctx
        self._prev: tuple[float, float] | None = None  # (usage_us, monotonic)

    def reset(self) -> None:
        self._prev = None

    def collect(self, sample: Sample, now: float) -> bool:
        reader = self.ctx.cgroup
        if reader is None or reader.cpu_version is None:
            return False
        cpu = reader.read_cpu()
        if cpu is None:
            return False
        limit = cpu["limit_cores"]
        sample.value("container.cpu.limit_cores", limit)
        self.ctx.cpu_limit = limit
        for key, field in (
            ("container.cpu.nr_periods", "nr_periods"),
            ("container.cpu.nr_throttled", "nr_throttled"),
            ("container.cpu.throttled_us", "throttled_us"),
        ):
            if cpu[field] is not None:
                sample.counter(key, cpu[field])
        usage = cpu["usage_us"]
        if usage is not None:
            prev, self._prev = self._prev, (float(usage), now)
            if prev is not None and not sample.frozen and now > prev[1] and usage >= prev[0]:
                cores = (usage - prev[0]) / ((now - prev[1]) * 1e6)
                sample.gauge("container.cpu.cores_used", cores)
                base = limit or self.ctx.host_cores()
                if base:
                    sample.gauge("container.cpu.pct_of_limit", min(100.0, cores / base * 100))
        return True


class ContainerMemory:
    """``container.memory``: the cgroup's memory (never workers' RSS summed)."""

    name = "container.memory"
    capability = "container.memory"
    every = 0.0
    expensive = False

    def __init__(self, ctx) -> None:
        self.ctx = ctx

    def reset(self) -> None:
        pass

    def collect(self, sample: Sample, now: float) -> bool:
        reader = self.ctx.cgroup
        if reader is None or reader.memory_version is None:
            return False
        mem = reader.read_memory()
        if mem is None:
            return False
        for name in ("current", "working_set", "anon", "file", "swap"):
            sample.gauge(f"container.memory.{name}", mem[name])
        sample.value("container.memory.limit", mem["limit"])
        if mem["oom_kill"] is not None:
            sample.counter("container.memory.oom_kill", mem["oom_kill"])
        return True


__all__ = [
    "CgroupReader",
    "ContainerCPU",
    "ContainerMemory",
    "container_id_from_cgroup_line",
    "container_id_from_mountinfo",
]
