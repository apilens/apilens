"""Runtime resources (M7): CPU, memory, container, runtime, pools, processes.

The client builds one :class:`ResourceSampler` per process when
``capture_resources`` is on (the default). It samples every
``resources_interval`` seconds (15 by default, at least 15) on a daemon
thread and each heartbeat drains the window into its ``resources`` block
(contract v1, ``testdata/resources/heartbeat_v1.json``). ``identity`` is
resolved once per process by :func:`resolve_identity`.

Modules, one concern each:

* ``_window``: a sample, the window aggregate and the wire block;
* ``sampler``: the thread, fork/gevent safety, budget, collector isolation;
* ``process``: the SDK process (CPU, RSS, PSS/USS, threads, fds);
* ``cgroup``: the container (cgroup v1/v2) and its id;
* ``identity``: host, container, Kubernetes pod and platform;
* ``runtime``: CPython GC and threads;
* ``pools``: SQLAlchemy and Django connection pools;
* ``processes``: the top processes of the container (never argv).
"""

from __future__ import annotations

from ._window import RESOURCES_VERSION, Sample, Window, compose
from .cgroup import CgroupReader, container_id_from_cgroup_line, container_id_from_mountinfo
from .identity import resolve_identity
from .sampler import (
    COLLECTORS,
    DEFAULT_INTERVAL_SECONDS,
    MIN_INTERVAL_SECONDS,
    ResourceSampler,
)

__all__ = [
    "COLLECTORS",
    "DEFAULT_INTERVAL_SECONDS",
    "MIN_INTERVAL_SECONDS",
    "RESOURCES_VERSION",
    "CgroupReader",
    "ResourceSampler",
    "Sample",
    "Window",
    "compose",
    "container_id_from_cgroup_line",
    "container_id_from_mountinfo",
    "resolve_identity",
]
