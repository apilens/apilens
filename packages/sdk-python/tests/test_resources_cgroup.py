"""cgroup v1/v2 reader against the shared fixtures (issue #1099).

``testdata/cgroup/expected.json`` is the table the TypeScript and Java readers
run too: each case is a fake filesystem under ``<case>/root`` and host cores
are injected as 8.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from apilens.client.resources import _window
from apilens.client.resources.cgroup import (
    CgroupReader,
    ContainerCPU,
    container_id_from_cgroup_line,
    container_id_from_mountinfo,
)

TESTDATA = Path(__file__).resolve().parents[3] / "testdata" / "cgroup"
EXPECTED = json.loads((TESTDATA / "expected.json").read_text())
CONTAINER_IDS = json.loads((TESTDATA / "container_ids.json").read_text())
HOST_CORES = 8


@pytest.mark.parametrize("case", sorted(EXPECTED["cases"]))
def test_every_fixture_produces_the_expected_values(case: str) -> None:
    want = {k: v for k, v in EXPECTED["cases"][case].items() if k != "note"}
    got = CgroupReader(str(TESTDATA / case / "root"), host_cores=HOST_CORES).read()
    assert got == want


@pytest.mark.parametrize("case", sorted(CONTAINER_IDS["cases"]))
def test_container_id_table(case: str) -> None:
    line, want = CONTAINER_IDS["cases"][case]
    assert container_id_from_cgroup_line(line) == want


def test_mountinfo_container_id_ignores_sandboxes() -> None:
    sandbox = "1 2 259:1 /var/lib/containerd/io.containerd.grpc.v1.cri/sandboxes/" + "a" * 64 + "/hostname /etc/hostname rw - ext4 /dev/root rw"
    assert container_id_from_mountinfo(sandbox) is None
    real = "3 2 259:1 /var/lib/docker/containers/" + "b" * 64 + "/resolv.conf /etc/resolv.conf rw - ext4 /dev/root rw"
    assert container_id_from_mountinfo(sandbox + "\n" + real) == "b" * 64


_TERM = "4 2 259:1 /var/lib/kubelet/pods/8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/containers/app/5f2c9e1a /dev/termination-log rw - ext4 /dev/root rw"


def test_mountinfo_termination_log_is_the_fallback() -> None:
    sandbox = "1 2 259:1 /var/lib/containerd/io.containerd.grpc.v1.cri/sandboxes/" + "a" * 64 + "/hostname /etc/hostname rw - ext4 /dev/root rw"
    assert container_id_from_mountinfo(sandbox + "\n" + _TERM) == "k8s:8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/app/5f2c9e1a"
    real = "3 2 259:1 /var/lib/docker/containers/" + "b" * 64 + "/resolv.conf /etc/resolv.conf rw - ext4 /dev/root rw"
    assert container_id_from_mountinfo(_TERM + "\n" + real) == "b" * 64  # containers/<id> wins
    # A custom terminationMessagePath mounts the same root elsewhere.
    custom = _TERM.replace("/dev/termination-log", "/tmp/msg")
    assert container_id_from_mountinfo(custom) == "k8s:8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/app/5f2c9e1a"
    # Pod-level kubelet files (etc-hosts, volumes) are not a container start.
    hosts = "5 2 259:1 /var/lib/kubelet/pods/8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/etc-hosts /etc/hosts rw - ext4 /dev/root rw"
    vol = "6 2 259:1 /var/lib/kubelet/pods/8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/volumes/kubernetes.io~empty-dir/data /data rw - ext4 /dev/root rw"
    assert container_id_from_mountinfo(hosts + "\n" + vol + "\n" + sandbox) is None


def _copy_case(tmp_path: Path, case: str) -> Path:
    root = tmp_path / case
    shutil.copytree(TESTDATA / case / "root", root)
    return root


def _leaf(root: Path) -> Path:
    return root / "sys" / "fs" / "cgroup"


def test_missing_file_nulls_only_that_field(tmp_path: Path) -> None:
    root = _copy_case(tmp_path, "v2_namespaced_limited")
    (_leaf(root) / "memory.stat").unlink()
    mem = CgroupReader(str(root), host_cores=HOST_CORES).read_memory()
    assert mem is not None
    assert mem["anon"] is None and mem["file"] is None and mem["working_set"] is None
    assert mem["current"] == 503316480 and mem["limit"] == 536870912 and mem["oom_kill"] == 1


def test_unreadable_file_nulls_only_that_field(tmp_path: Path, monkeypatch) -> None:
    root = _copy_case(tmp_path, "v2_namespaced_limited")
    denied = str(_leaf(root) / "cpu.stat")
    real_open = open

    def fake_open(path, *args, **kwargs):
        if str(path) == denied:
            raise PermissionError(13, "Permission denied", path)
        return real_open(path, *args, **kwargs)

    import apilens.client.resources.cgroup as cgroup_mod

    monkeypatch.setattr(cgroup_mod, "open", fake_open, raising=False)
    cpu = CgroupReader(str(root), host_cores=HOST_CORES).read_cpu()
    assert cpu == {
        "limit_cores": 0.5,
        "usage_us": None,
        "nr_periods": None,
        "nr_throttled": None,
        "throttled_us": None,
    }


def test_effective_cores_is_min_of_quota_affinity_and_cpuset(tmp_path: Path) -> None:
    root = _copy_case(tmp_path, "v2_namespaced_limited")
    leaf = _leaf(root)
    (leaf / "cpu.max").write_text("400000 100000\n")  # quota: 4 cores
    assert CgroupReader(str(root), host_cores=8).limit_cores() == 4.0
    assert CgroupReader(str(root), host_cores=3).limit_cores() == 3.0  # affinity
    (leaf / "cpuset.cpus.effective").write_text("0-1\n")  # cpuset: 2 CPUs
    assert CgroupReader(str(root), host_cores=8).limit_cores() == 2.0
    assert CgroupReader(str(root), host_cores=8).host_cores() == 2


def test_no_quota_means_no_limit_even_with_a_cpuset(tmp_path: Path) -> None:
    root = _copy_case(tmp_path, "v2_unlimited")
    (_leaf(root) / "cpuset.cpus.effective").write_text("0-3\n")
    reader = CgroupReader(str(root), host_cores=8)
    assert reader.limit_cores() is None
    assert reader.host_cores() == 4


def test_memory_limit_above_host_memtotal_is_no_limit(tmp_path: Path) -> None:
    root = _copy_case(tmp_path, "v2_namespaced_limited")
    (root / "proc" / "meminfo").write_text("MemTotal:         262144 kB\n")  # 256 MiB host
    assert CgroupReader(str(root), host_cores=8).memory_limit() is None


def test_no_cgroup_root_reads_nothing(tmp_path: Path) -> None:
    reader = CgroupReader(str(tmp_path), host_cores=8)  # e.g. macOS: no /proc at all
    assert not reader.available
    assert reader.read() == {"limit_source": "none", "container_id": None, "cpu": None, "memory": None}


class _Ctx:
    def __init__(self, reader: CgroupReader) -> None:
        self.cgroup = reader
        self.cpu_limit = None

    def host_cores(self) -> int:
        return HOST_CORES


def _cpu_stat(root: Path, usage: int, periods: int, throttled: int, throttled_us: int) -> None:
    (_leaf(root) / "cpu.stat").write_text(
        f"usage_usec {usage}\nnr_periods {periods}\nnr_throttled {throttled}\nthrottled_usec {throttled_us}\n"
    )


def test_throttled_ratio_is_computed_from_deltas(tmp_path: Path) -> None:
    root = _copy_case(tmp_path, "v2_namespaced_limited")
    collector = ContainerCPU(_Ctx(CgroupReader(str(root), host_cores=HOST_CORES)))
    window = _window.Window(0.0)
    baseline: dict = {}

    def step(now: float, *stat: int) -> None:
        _cpu_stat(root, *stat)
        sample = _window.Sample()
        collector.collect(sample, now)
        deltas = {}
        for k, raw in sample.counters.items():
            if k in baseline:
                deltas[k] = raw - baseline[k]
            baseline[k] = raw
        window.merge(sample, deltas, None)

    # Lifetime totals (1000 periods, 180 throttled) must not leak in: only
    # the 100 periods of the window, 50 of them throttled.
    step(0.0, 10_000_000, 1000, 180, 2_400_000)
    step(15.0, 13_750_000, 1100, 230, 2_900_000)
    block = _window.compose(window, 15.0, capabilities=[], limit_source="cgroup_v2")
    cpu = block["container"]["cpu"]
    assert cpu["throttled_ratio"] == 0.5
    assert cpu["throttled_us"] == 500_000
    assert cpu["limit_cores"] == 0.5
    # 3.75 s of CPU in 15 s = 0.25 cores = 50 % of the 0.5-core limit.
    assert cpu["cores_used"]["last"] == 0.25
    assert cpu["pct_of_limit"]["last"] == 50


def test_v1_reports_microseconds(tmp_path: Path) -> None:
    cpu = CgroupReader(str(TESTDATA / "v1_docker" / "root"), host_cores=HOST_CORES).read_cpu()
    assert cpu["usage_us"] == 45_000_000 and cpu["throttled_us"] == 1_500_000
    assert os.path.exists(TESTDATA / "v1_docker" / "root" / "sys" / "fs" / "cgroup" / "memory")
