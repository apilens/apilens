"""The resource sampler: a daemon thread that samples every collector every
``resources_interval`` seconds into one window per heartbeat consumer.

Safety rules (decision D11 of the M7 plan):

* Every collector is isolated: an exception is swallowed and counted
  (``errors``), and a collector that fails 5 times in a row is turned off.
  Nothing a collector does can stop the sampler or reach the application.
* The thread is a daemon and never keeps the process alive. Under gevent or
  eventlet monkey-patching it is a real OS thread (``monkey.get_original``),
  so a blocking ``/proc`` read never stalls the hub, and it uses the
  original ``sleep`` and lock.
* Fork-safe: ``os.register_at_fork(after_in_child=...)`` gives the child a
  fresh lock, fresh windows, fresh counter baselines and fresh collector
  state (its first CPU reading is a baseline, never the parent's), and the
  thread is restarted by :meth:`ensure_running`.
* Self-measured: the CPU time of each sample (``time.thread_time``) is the
  ``sampler_cost_us`` of the window. Above 0.1 % of one core the expensive
  collectors (PSS and the process list) are skipped and the window is flagged
  ``sampler_backoff`` until the cost drops under half the budget.
* Serverless: a wall-clock jump over 2x the interval between two samples
  (Lambda froze the process) flags the window ``freeze_gap`` and the rate
  collectors re-baseline instead of reporting a diluted CPU figure. In inline
  mode there is no thread: the client samples on ``flush()`` when one is due.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
import weakref
from collections.abc import Callable, Hashable, Iterable
from typing import Any, Protocol

from .._policy import ResourcesPolicy
from ._window import Sample, Window, compose
from .cgroup import CgroupReader, ContainerCPU, ContainerMemory
from .identity import _is_vm
from .pools import Pools
from .process import ProcessCPU, ProcessMemory, ProcessPSS, load_psutil
from .processes import Processes
from .runtime import PythonRuntime

logger = logging.getLogger("apilens")

#: Collector names, in payload order. The remote policy's
#: ``disabled_collectors`` uses the same names.
COLLECTORS = (
    "process.cpu",
    "process.memory",
    "process.pss",
    "container.cpu",
    "container.memory",
    "runtime",
    "pools",
    "processes",
)
DEFAULT_INTERVAL_SECONDS = 15.0
MIN_INTERVAL_SECONDS = 15.0
MAX_CONSECUTIVE_FAILURES = 5
#: Sampler budget: this fraction of one core.
BUDGET_CORE_FRACTION = 0.001
#: A gap over this many intervals between samples is a freeze.
FREEZE_FACTOR = 2.0
# Flags that describe the process, not one window: repeated every window.
_STICKY_FLAGS = frozenset({"host_pid_namespace", "python_threads_only", "serverless"})


class Collector(Protocol):
    """What the sampler needs of a collector (see the modules next to this one).

    ``collect`` writes into the sample and returns ``True`` when it measured
    something (its ``capability`` is then advertised). ``every`` > 0 runs it
    at most that often; ``expensive`` ones are dropped first when the
    sampler is over budget. An ``off`` attribute that turns true disables it
    for good (no PSS permission, a host PID namespace)."""

    name: str
    capability: str
    every: float
    expensive: bool

    def collect(self, sample: Sample, now: float) -> bool: ...

    def reset(self) -> None: ...


class _Context:
    """State the collectors share: the cgroup reader and the CPU limit."""

    def __init__(self, root: str) -> None:
        self.root = root
        try:
            reader: CgroupReader | None = CgroupReader(root)
        except Exception:
            reader = None
        self.cgroup = reader if reader is not None and reader.available else None
        self.cpu_limit: float | None = None
        self._host: int | None = None
        if self.cgroup is not None:
            try:
                self.cpu_limit = self.cgroup.limit_cores()
            except Exception:
                self.cpu_limit = None

    def host_cores(self) -> int:
        if self._host is None:
            try:
                if self.cgroup is not None:
                    self._host = self.cgroup.host_cores()
                else:
                    self._host = len(os.sched_getaffinity(0))  # type: ignore[attr-defined]
            except Exception:
                self._host = os.cpu_count() or 1
        return self._host


def _real_threading() -> tuple[Callable, Callable, Callable] | None:
    """``(start_new_thread, sleep, allocate_lock)`` of the unpatched stdlib
    when gevent or eventlet has monkey-patched threading, else ``None``. The
    green libraries are only consulted when the app already imported them."""
    if "gevent" in sys.modules:
        try:
            from gevent import monkey

            if monkey.is_module_patched("threading") or monkey.is_module_patched("time"):
                return (
                    monkey.get_original("_thread", "start_new_thread"),
                    monkey.get_original("time", "sleep"),
                    monkey.get_original("_thread", "allocate_lock"),
                )
        except Exception:
            pass
    if "eventlet" in sys.modules:
        try:
            from eventlet import patcher

            if patcher.is_monkey_patched("thread") or patcher.is_monkey_patched("time"):
                real_thread = patcher.original("_thread")
                real_time = patcher.original("time")
                return real_thread.start_new_thread, real_time.sleep, real_thread.allocate_lock
        except Exception:
            pass
    return None


_samplers: "weakref.WeakSet[ResourceSampler]" = weakref.WeakSet()
_fork_hooked = [False]


def _after_fork_in_child() -> None:
    for sampler in list(_samplers):
        try:
            sampler._after_fork()
        except Exception:  # pragma: no cover - never break a fork
            pass


def _hook_fork() -> None:
    if not _fork_hooked[0] and hasattr(os, "register_at_fork"):
        os.register_at_fork(after_in_child=_after_fork_in_child)
        _fork_hooked[0] = True


class ResourceSampler:
    """Samples every collector each ``interval`` seconds into one window per
    consumer (``register``); each heartbeat ``drain``\\ s its own window."""

    def __init__(
        self,
        *,
        interval: float = DEFAULT_INTERVAL_SECONDS,
        capture_process_list: bool = True,
        serverless: bool = False,
        root: str = "/",
        collectors: Iterable[Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self.local_interval = float(interval)
        self.capture_process_list = capture_process_list
        self.serverless = serverless
        self.root = root
        self._clock = clock
        self._wall = wall
        self._real = _real_threading()
        self._lock = self._new_lock()
        self._wake = threading.Event()
        self._windows: dict[Hashable, Window] = {}
        self._baseline: dict[Hashable, float] = {}
        self._last_mono: float | None = None
        self._last_wall: float | None = None
        self._last_run: dict[str, float] = {}
        self._failures: dict[str, int] = {}
        #: Exceptions raised per collector since start (never reset).
        self.errors: dict[str, int] = {}
        self._disabled: set[str] = set()
        self._produced: set[str] = set()
        self._sticky: set[str] = {"serverless"} if serverless else set()
        self._backoff = False
        self._cost_avg: float | None = None
        self._remote = ResourcesPolicy()
        self._gen = 0
        self._running = False
        self._want_running = False
        self._pid = os.getpid()
        self._custom = collectors is not None
        self.ctx = _Context(root)
        self.collectors: list[Any] = list(collectors) if collectors is not None else self._default_collectors()
        self._limit_source = self._resolve_limit_source()
        _samplers.add(self)
        _hook_fork()

    # ── setup ───────────────────────────────────────────────────────────

    def _new_lock(self):
        return self._real[2]() if self._real is not None else threading.Lock()

    def _default_collectors(self) -> list[Any]:
        ctx = self.ctx
        proc_root = os.path.join(self.root, "proc")
        out: list[Any] = [
            ProcessCPU(ctx),
            ProcessMemory(ctx, proc_root=proc_root, psutil=load_psutil()),
            ProcessPSS(ctx, proc_root=proc_root),
            ContainerCPU(ctx),
            ContainerMemory(ctx),
            PythonRuntime(ctx),
            Pools(ctx),
        ]
        if self.capture_process_list:
            out.append(Processes(ctx, proc_root=proc_root))
        return out

    def _resolve_limit_source(self) -> str:
        if self.ctx.cgroup is not None:
            return self.ctx.cgroup.limit_source
        try:
            return "vm" if _is_vm(self.root) else "host"
        except Exception:
            return "host"

    @property
    def limit_source(self) -> str:
        return self._limit_source

    @property
    def container_id(self) -> str:
        reader = self.ctx.cgroup
        return (reader.container_id or "") if reader is not None else ""

    @property
    def interval(self) -> float:
        """The effective interval: the local one, lengthened (never
        shortened) by the remote ``min_interval_s``."""
        return max(self.local_interval, float(self._remote.min_interval_s or 0))

    @property
    def enabled(self) -> bool:
        return self._remote.enabled

    @property
    def disabled_collectors(self) -> frozenset[str]:
        return frozenset(self._disabled) | self._remote.disabled_collectors

    def capabilities(self) -> list[str]:
        off = self.disabled_collectors
        out = []
        for c in self.collectors:
            if c.capability in self._produced and c.name not in off and c.capability not in out:
                out.append(c.capability)
        return out

    # ── thread ──────────────────────────────────────────────────────────

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        """Start the sampling thread (not in serverless mode)."""
        self._want_running = True
        if self.serverless:
            return
        self._spawn()

    def _spawn(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self._gen += 1
            gen = self._gen
        self._wake.clear()
        try:
            if self._real is not None:
                self._real[0](self._loop, (gen,))
            else:
                threading.Thread(
                    target=self._loop, args=(gen,), daemon=True, name="apilens-resources"
                ).start()
        except Exception:
            self._running = False
            logger.debug("API Lens could not start the resource sampler", exc_info=True)

    def stop(self) -> None:
        self._want_running = False
        with self._lock:
            self._gen += 1
            self._running = False
        self._wake.set()
        for c in self.collectors:
            stop = getattr(c, "stop", None)
            if stop is not None:
                try:
                    stop()
                except Exception:
                    pass

    def ensure_running(self) -> None:
        """Restart the thread when it should run but does not (a forked
        child, whose threads did not survive the fork)."""
        self._check_fork()
        if self._want_running and not self._running and not self.serverless:
            self._spawn()

    def _wait(self, seconds: float, gen: int) -> None:
        if self._real is None:
            self._wake.wait(seconds)
            return
        sleep = self._real[1]
        end = time.monotonic() + seconds
        while gen == self._gen:
            left = end - time.monotonic()
            if left <= 0:
                return
            sleep(min(1.0, left))

    def _loop(self, gen: int) -> None:
        try:
            while gen == self._gen:
                try:
                    self.sample_now()
                except Exception:  # pragma: no cover - sample_now isolates collectors
                    logger.debug("API Lens resource sample failed", exc_info=True)
                self._wait(self.interval, gen)
        finally:
            if gen == self._gen:
                self._running = False

    # ── fork ────────────────────────────────────────────────────────────

    def _check_fork(self) -> None:
        if os.getpid() != self._pid:
            self._after_fork()

    def _after_fork(self) -> None:
        if os.getpid() == self._pid:
            return
        self._pid = os.getpid()
        self._lock = self._new_lock()
        self._wake = threading.Event()
        self._running = False
        self._gen += 1
        now = self._clock()
        self._windows = {key: Window(now) for key in self._windows}
        self._baseline = {}
        self._last_mono = None
        self._last_wall = None
        self._last_run = {}
        self._failures = {}
        self._cost_avg = None
        self._backoff = False
        for c in self.collectors:
            try:
                c.reset()
            except Exception:
                pass

    # ── policy ──────────────────────────────────────────────────────────

    def apply_policy(self, policy: ResourcesPolicy) -> None:
        """The remote ``policy.resources``; it only ever narrows local config."""
        if policy == self._remote:
            return
        self._remote = policy
        if not policy.enabled:
            with self._lock:
                now = self._clock()
                self._windows = {key: Window(now) for key in self._windows}

    # ── sampling ────────────────────────────────────────────────────────

    def register(self, key: Hashable) -> None:
        with self._lock:
            if key not in self._windows:
                self._windows[key] = Window(self._clock())

    def maybe_sample(self) -> bool:
        """Sample when one is due (inline / serverless mode, from ``flush()``)."""
        self._check_fork()
        if self._last_mono is not None and self._clock() - self._last_mono < self.interval:
            return False
        self.sample_now()
        return True

    def sample_now(self) -> None:
        """Run every collector once and merge the sample into every window."""
        self._check_fork()
        if not self._remote.enabled:
            return
        mono, wall = self._clock(), self._wall()
        frozen = False
        if self._last_mono is not None and self._last_wall is not None:
            gap = max(mono - self._last_mono, wall - self._last_wall)
            frozen = gap > FREEZE_FACTOR * self.interval
        self._last_mono, self._last_wall = mono, wall
        sample = Sample(frozen=frozen)
        if frozen:
            sample.flag("freeze_gap")
        remote_off = self._remote.disabled_collectors
        started = _thread_time()
        for c in self.collectors:
            name = c.name
            if name in self._disabled or name in remote_off:
                continue
            if self._backoff and getattr(c, "expensive", False):
                continue
            every = getattr(c, "every", 0.0)
            last = self._last_run.get(name)
            if every and last is not None and mono - last < every:
                continue
            if getattr(c, "off", False):
                self._disabled.add(name)
                continue
            try:
                ok = c.collect(sample, mono)
            except Exception as exc:
                self.errors[name] = self.errors.get(name, 0) + 1
                failures = self._failures.get(name, 0) + 1
                self._failures[name] = failures
                if failures >= MAX_CONSECUTIVE_FAILURES:
                    self._disabled.add(name)
                    logger.debug(
                        "API Lens resource collector %s failed %d times in a row; turned off: %r",
                        name,
                        failures,
                        exc,
                    )
                continue
            self._failures[name] = 0
            self._last_run[name] = mono
            if ok:
                self._produced.add(c.capability)
            if getattr(c, "off", False):
                self._disabled.add(name)
        cost_us = (_thread_time() - started) * 1e6
        with self._lock:
            deltas = self._deltas(sample.counters)
            self._sticky |= sample.flags & _STICKY_FLAGS
            for w in self._windows.values():
                w.merge(sample, deltas, cost_us)
                if self._backoff:
                    w.flag("sampler_backoff")
        self._update_backoff(cost_us)

    def _deltas(self, counters: dict[Hashable, float]) -> dict[Hashable, float]:
        out: dict[Hashable, float] = {}
        for key, raw in counters.items():
            prev = self._baseline.get(key)
            self._baseline[key] = raw
            # A counter that went backwards was reset: re-baseline, never negative.
            if prev is not None and raw >= prev:
                out[key] = raw - prev
        return out

    def budget_us(self) -> float:
        return BUDGET_CORE_FRACTION * self.interval * 1e6

    def _update_backoff(self, cost_us: float) -> None:
        avg = cost_us if self._cost_avg is None else 0.8 * self._cost_avg + 0.2 * cost_us
        self._cost_avg = avg
        budget = self.budget_us()
        if not self._backoff and avg > budget:
            self._backoff = True
            logger.debug(
                "API Lens resource sampler over budget (%.0f us > %.0f us per sample); "
                "skipping PSS and the process list",
                avg,
                budget,
            )
        elif self._backoff and avg < budget / 2:
            self._backoff = False

    @property
    def backoff(self) -> bool:
        return self._backoff

    def drain(self, key: Hashable) -> dict | None:
        """The ``resources`` block of ``key``'s window, which starts anew; ``None``
        when it holds no sample or resources are remotely disabled."""
        self._check_fork()
        with self._lock:
            now = self._clock()
            w = self._windows.get(key)
            self._windows[key] = Window(now)
        if w is None or not self._remote.enabled:
            return None
        w.flags |= self._sticky
        try:
            return compose(
                w,
                now,
                capabilities=self.capabilities(),
                limit_source=self.limit_source,
                container_id=self.container_id,
            )
        except Exception:  # pragma: no cover - never fail a heartbeat
            logger.debug("API Lens could not build the resources block", exc_info=True)
            return None


def _thread_time() -> float:
    try:
        return time.thread_time()
    except (AttributeError, OSError):  # pragma: no cover
        return time.process_time()


__all__ = [
    "BUDGET_CORE_FRACTION",
    "COLLECTORS",
    "DEFAULT_INTERVAL_SECONDS",
    "MAX_CONSECUTIVE_FAILURES",
    "MIN_INTERVAL_SECONDS",
    "ResourceSampler",
]
