"""Processes in the same container (issue #1103): our cgroup only, top 20 by
RSS, never argv / environ / cwd, off in a host PID namespace."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from apilens.client.resources import ResourceSampler, Sample
from apilens.client.resources import processes as processes_mod
from apilens.client.resources.processes import Processes

OWN_CGROUP = "0::/kubepods.slice/pod-a/cri-containerd-aaaa.scope\n"
OTHER_CGROUP = "0::/kubepods.slice/pod-a/cri-containerd-bbbb.scope\n"
SECRET = "--password=s3cr3t"


def _proc(tmp_path: Path, pid: int, *, comm: str, rss_pages: int, cgroup: str, ppid: int = 1, ticks: int = 100) -> None:
    d = tmp_path / str(pid)
    d.mkdir(parents=True, exist_ok=True)
    fields = ["S", str(ppid)] + ["0"] * 9 + [str(ticks), "0"] + ["0"] * 8 + [str(rss_pages)] + ["0"] * 20
    (d / "stat").write_text(f"{pid} ({comm}) " + " ".join(fields) + "\n")
    (d / "comm").write_text(comm + "\n")
    (d / "cgroup").write_text(cgroup)
    (d / "cmdline").write_text(f"python\0app.py\0{SECRET}\0")
    (d / "environ").write_text("DB_PASSWORD=s3cr3t\0")


def _tree(tmp_path: Path, n_ours: int = 3, n_other: int = 2, init: str = "tini") -> Path:
    root = tmp_path / "proc"
    root.mkdir()
    (root / "self").mkdir()
    (root / "self" / "cgroup").write_text(OWN_CGROUP)
    _proc(root, 1, comm=init, rss_pages=10, cgroup=OWN_CGROUP, ppid=0)
    for i in range(n_ours):
        _proc(root, 100 + i, comm=f"worker-with-a-very-long-name-{i}", rss_pages=1000 + i, cgroup=OWN_CGROUP)
    for i in range(n_other):
        _proc(root, 900 + i, comm="sidecar", rss_pages=99999, cgroup=OTHER_CGROUP)
    return root


def test_only_our_cgroup_largest_rss_first_comm_capped(tmp_path: Path) -> None:
    p = Processes(None, proc_root=str(_tree(tmp_path)))
    rows = p.list(0.0)
    assert [r["pid"] for r in rows] == [102, 101, 100, 1]
    assert all(set(r) <= {"pid", "ppid", "comm", "cpu_pct", "rss"} for r in rows)
    assert rows[0]["comm"] == "worker-with-a-v"  # 15 characters
    assert rows[0]["ppid"] == 1
    assert "cpu_pct" not in rows[0]  # first listing: no CPU delta yet


def test_cpu_pct_from_deltas(tmp_path: Path) -> None:
    root = _tree(tmp_path, n_ours=1, n_other=0)
    p = Processes(None, proc_root=str(root))
    p.list(0.0)
    tick = processes_mod._sysconf("SC_CLK_TCK", 100)
    _proc(root, 100, comm="worker", rss_pages=1000, cgroup=OWN_CGROUP, ticks=100 + tick * 3)
    rows = {r["pid"]: r for r in p.list(60.0)}
    assert rows[100]["cpu_pct"] == 5.0  # 3 s of CPU over 60 s


def test_cap_of_20(tmp_path: Path) -> None:
    p = Processes(None, proc_root=str(_tree(tmp_path, n_ours=30)))
    rows = p.list(0.0)
    assert len(rows) == 20
    assert rows[0]["pid"] == 129


def test_secret_argv_never_in_payload_and_never_read(tmp_path: Path, monkeypatch) -> None:
    root = _tree(tmp_path)
    opened: list[str] = []
    real_open = open

    def spy(path, *args, **kwargs):
        opened.append(str(path))
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(processes_mod, "open", spy, raising=False)
    s = ResourceSampler(collectors=[Processes(None, proc_root=str(root))], interval=15.0)
    s.register("k")
    s.sample_now()
    payload = json.dumps(s.drain("k"))
    assert "s3cr3t" not in payload and "password" not in payload
    assert opened
    assert {os.path.basename(p) for p in opened} <= set(processes_mod.READ_FILES)


def test_host_pid_namespace_turns_the_list_off(tmp_path: Path) -> None:
    root = _tree(tmp_path, n_ours=510, n_other=0, init="systemd")
    p = Processes(None, proc_root=str(root))
    s = ResourceSampler(collectors=[p], interval=15.0)
    s.register("k")
    s.sample_now()
    block = s.drain("k")
    assert "processes" not in block
    assert "host_pid_namespace" in block["flags"]
    assert p.off and "processes" in s.disabled_collectors
    s.sample_now()
    assert "host_pid_namespace" in s.drain("k")["flags"]  # sticky


def test_few_processes_under_systemd_is_not_host_pid(tmp_path: Path) -> None:
    p = Processes(None, proc_root=str(_tree(tmp_path, n_ours=5, init="systemd")))
    assert p.list(0.0) is not None and not p.host_pid


def test_capture_process_list_false_removes_the_collector() -> None:
    s = ResourceSampler(interval=15.0, capture_process_list=False)
    assert "processes" not in [c.name for c in s.collectors]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="/proc is Linux only")
def test_real_child_with_secret_argv_never_appears() -> None:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", SECRET])
    try:
        time.sleep(0.2)
        p = Processes(None)
        sample = Sample()
        p.collect(sample, time.monotonic())
        payload = json.dumps(sample.items.get("processes", []))
        assert "s3cr3t" not in payload
        if not p.host_pid:
            assert child.pid in [r["pid"] for r in sample.items.get("processes", [])] or len(sample.items["processes"]) == 20
    finally:
        child.kill()
        child.wait()
