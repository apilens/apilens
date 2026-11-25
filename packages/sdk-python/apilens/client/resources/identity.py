"""Where the process runs: host, container, Kubernetes pod and platform.

Resolved once per process (and again in a forked child, whose start time
differs) and sent as the heartbeat's ``identity``. Sources, in order:
Downward API env vars, then well-known files, then a guess from the hostname
(``hostname_guess: true``).

* Kubernetes: ``POD_NAME`` / ``K8S_POD_NAME``, ``POD_NAMESPACE``,
  ``NODE_NAME``, ``POD_UID``; the service-account namespace file (missing
  with ``automountServiceAccountToken: false``); ``KUBERNETES_SERVICE_HOST``
  marks the platform. Without the Downward API the pod name is the hostname,
  which is wrong under ``hostNetwork``, hence the guess flag.
* Container id: ``/proc/self/cgroup``, else ``/proc/self/mountinfo`` (all a
  cgroup v2 namespace shows): a ``containers/<id>`` mount source, else
  kubelet's termination-log mount as ``k8s:<pod-uid>/<container>/<suffix>``
  (containerd + cgroup v2, where hostname and resolv.conf are the pod
  sandbox's; a sandbox id is per pod and never used).
* ECS: one fetch of ``ECS_CONTAINER_METADATA_URI_V4`` bounded to 1 s, made on
  the heartbeat thread, never on the request path; a failure is silent.
* Cloud Run ``K_*``, App Engine ``GAE_*``, Heroku ``DYNO``, fly.io ``FLY_*``,
  Lambda ``AWS_LAMBDA_*``; a VM is recognised from DMI / hypervisor files.
"""

from __future__ import annotations

import json
import os
import re
import socket
import time
import urllib.request
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from .cgroup import CgroupReader

ECS_TIMEOUT_SECONDS = 1.0
NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"
_POD_UID_CGROUP = re.compile(r"pod([0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12})")
_POD_UID_MOUNT = re.compile(r"/kubelet/pods/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/")
_HYPERVISORS = (
    "amazon ec2",
    "google",
    "kvm",
    "qemu",
    "vmware",
    "virtualbox",
    "xen",
    "microsoft corporation",
    "openstack",
    "droplet",
    "hetzner",
    "bochs",
    "parallels",
)

# The start-time fallback when neither psutil nor /proc can tell: the SDK's
# import (at most the import delay late), or the fork that made this child.
_started_wall = [time.time()]


def _forked() -> None:
    _started_wall[0] = time.time()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_forked)


def _first(env: Mapping[str, str], *names: str) -> str:
    for name in names:
        value = (env.get(name) or "").strip()
        if value:
            return value
    return ""


def _read(root: str, path: str) -> str | None:
    try:
        with open(os.path.join(root, path.lstrip("/")), encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def iso_utc(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def process_start_epoch(root: str = "/", psutil: Any = None) -> float:
    """When this process started, as a Unix time."""
    if psutil is not None:
        try:
            return float(psutil.Process().create_time())
        except Exception:
            pass
    stat = _read(root, "/proc/self/stat")
    proc_stat = _read(root, "/proc/stat")
    if stat and proc_stat:
        try:
            fields = stat[stat.rfind(")") + 2 :].split()
            ticks = int(fields[19])  # field 22: starttime, clock ticks after boot
            btime = next(int(l.split()[1]) for l in proc_stat.splitlines() if l.startswith("btime"))
            return btime + ticks / os.sysconf("SC_CLK_TCK")
        except (IndexError, ValueError, StopIteration, OSError, AttributeError):
            pass
    return _started_wall[0]


def _is_vm(root: str) -> bool:
    if (_read(root, "/sys/hypervisor/type") or "").strip():
        return True
    for name in ("sys_vendor", "product_name", "bios_vendor"):
        text = (_read(root, f"/sys/class/dmi/id/{name}") or "").strip().lower()
        if text and any(h in text for h in _HYPERVISORS):
            return True
    return False


def detect_platform(env: Mapping[str, str], root: str = "/") -> str:
    if _first(env, "AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_RUNTIME_API"):
        return "lambda"
    if _first(env, "KUBERNETES_SERVICE_HOST"):
        return "k8s"
    if _first(env, "K_SERVICE", "CLOUD_RUN_JOB"):
        return "cloud_run"
    if _first(env, "GAE_SERVICE", "GAE_APPLICATION"):
        return "app_engine"
    if _first(env, "ECS_CONTAINER_METADATA_URI_V4", "ECS_CONTAINER_METADATA_URI"):
        return "ecs"
    if _first(env, "DYNO"):
        return "heroku"
    if _first(env, "FLY_APP_NAME", "FLY_MACHINE_ID", "FLY_ALLOC_ID"):
        return "fly"
    if _is_vm(root):
        return "vm"
    return "bare"


def fetch_ecs_metadata(uri: str, timeout: float = ECS_TIMEOUT_SECONDS) -> dict | None:
    """The ECS container metadata document, or ``None`` (silently) on any
    failure. Direct connection: the task metadata endpoint is link-local and
    must not go through an egress proxy."""
    if not uri.startswith(("http://", "https://")):
        return None
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(uri, timeout=timeout) as resp:
            data = json.loads(resp.read(256 * 1024).decode("utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def resolve_identity(
    env: Mapping[str, str] | None = None,
    *,
    root: str = "/",
    cgroup: CgroupReader | None = None,
    hostname: str | None = None,
    psutil: Any = None,
    ecs_fetch=fetch_ecs_metadata,
) -> dict[str, Any]:
    """The heartbeat ``identity`` object (empty fields left out)."""
    env = os.environ if env is None else env
    host = hostname if hostname is not None else socket.gethostname()
    platform = detect_platform(env, root)
    reader = cgroup if cgroup is not None else CgroupReader(root)
    ident: dict[str, Any] = {"hostname": host[:253]}

    pod = _first(env, "POD_NAME", "K8S_POD_NAME", "MY_POD_NAME", "KUBERNETES_POD_NAME")
    guess = not pod
    if platform == "k8s" and not pod:
        pod = host
    ident["hostname_guess"] = guess

    container_id = reader.container_id or ""
    region = _first(env, "AWS_REGION", "AWS_DEFAULT_REGION", "FLY_REGION", "GOOGLE_CLOUD_REGION")

    if platform == "ecs":
        uri = _first(env, "ECS_CONTAINER_METADATA_URI_V4", "ECS_CONTAINER_METADATA_URI")
        meta = ecs_fetch(uri) if uri else None
        if meta:
            container_id = str(meta.get("DockerId") or container_id)
            labels = meta.get("Labels") if isinstance(meta.get("Labels"), dict) else {}
            arn = str(labels.get("com.amazonaws.ecs.task-arn") or "")
            if not region and arn.startswith("arn:"):
                parts = arn.split(":")
                region = parts[3] if len(parts) > 3 else ""
    if container_id:
        ident["container_id"] = container_id[:128]
    if pod:
        ident["pod_name"] = pod[:253]

    if platform == "k8s":
        uid = _first(env, "POD_UID", "K8S_POD_UID", "MY_POD_UID")
        if not uid:
            m = _POD_UID_CGROUP.search(reader.cgroup_text)
            if m:
                uid = m.group(1).replace("_", "-")
            elif (reader.container_id or "").startswith("k8s:"):
                # k8s:<pod-uid>/<container>/<suffix> from the termination-log mount.
                uid = (reader.container_id or "")[4:].split("/", 1)[0]
            else:
                m = _POD_UID_MOUNT.search(_read(root, "/proc/self/mountinfo") or "")
                uid = m.group(1) if m else ""
        if uid:
            ident["pod_uid"] = uid[:64]
        namespace = _first(env, "POD_NAMESPACE", "K8S_NAMESPACE", "MY_POD_NAMESPACE")
        if not namespace:
            namespace = (_read(root, NAMESPACE_FILE) or "").strip()
        if namespace:
            ident["namespace"] = namespace[:253]
        node = _first(env, "NODE_NAME", "K8S_NODE_NAME", "MY_NODE_NAME")
        if node:
            ident["node_name"] = node[:253]
    ident["platform"] = platform
    if region:
        ident["region"] = region[:64]
    ident["process_start_time"] = iso_utc(process_start_epoch(root, psutil))
    return ident


__all__ = ["detect_platform", "fetch_ecs_metadata", "iso_utc", "process_start_epoch", "resolve_identity"]
