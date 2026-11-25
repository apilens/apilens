"""Resource sampler core (issue #1097): window aggregate, isolation, budget,
fork safety, gevent, kill switch and the heartbeat wiring.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

from apilens.client import ApiLensClient, ApiLensConfig
from apilens.client._policy import ResourcesPolicy, parse_policy
from apilens.client.resources import ResourceSampler, Sample
from apilens.client.resources import sampler as sampler_mod

SDK_ROOT = Path(__file__).resolve().parents[1]
GOLDEN = SDK_ROOT.parents[1] / "testdata" / "resources" / "heartbeat_v1.json"
KEY = ("orders-api", "production")


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class Fixed:
    """A collector writing fixed values for every part of the block."""

    name = "fixed"
    capability = "process.cpu"
    every = 0.0
    expensive = False

    def __init__(self) -> None:
        self.calls = 0

    def reset(self) -> None:
        pass

    def collect(self, sample: Sample, now: float) -> bool:
        self.calls += 1
        i = self.calls
        sample.gauge("process.cpu.cores_used", 0.1 * i)
        sample.gauge("process.cpu.pct_of_limit", 10.0 * i)
        for k in ("rss", "pss", "uss"):
            sample.gauge(f"process.memory.{k}", 1000.0 * i)
        sample.gauge("process.threads", 8)
        sample.gauge("process.fds", 30 + i)
        sample.gauge("container.cpu.cores_used", 0.5)
        sample.gauge("container.cpu.pct_of_limit", 50)
        sample.value("container.cpu.limit_cores", 1.0)
        sample.counter("container.cpu.nr_periods", 100 * i)
        sample.counter("container.cpu.nr_throttled", 10 * i)
        sample.counter("container.cpu.throttled_us", 1000 * i)
        for k in ("current", "working_set", "anon", "file", "swap"):
            sample.gauge(f"container.memory.{k}", 2000.0 * i)
        sample.value("container.memory.limit", 536870912)
        sample.counter("container.memory.oom_kill", 0)
        sample.value("runtime.gc.generations", 3)
        for g in range(3):
            for f in ("collections", "collected", "uncollectable"):
                sample.counter(f"runtime.gc.{g}.{f}", 5 * i)
            sample.add(f"runtime.gc.{g}.pause_ms_sum", 0.5)
            sample.peak(f"runtime.gc.{g}.pause_ms_max", 0.25 * i)
        sample.gauge("runtime.threads", 4)
        sample.value("runtime.gil_enabled", True)
        sample.gauge(("pool", "default", "used"), i)
        sample.gauge(("pool", "default", "pending"), 0)
        sample.set_items("pools", [{"name": "default", "kind": "sqlalchemy", "idle": 2, "max": 10}])
        sample.set_items("processes", [{"pid": 1, "ppid": 0, "comm": "gunicorn", "cpu_pct": 1.5, "rss": 1000}])
        return True


class Boom:
    name = "boom"
    capability = "boom"
    every = 0.0
    expensive = False

    def __init__(self) -> None:
        self.calls = 0

    def reset(self) -> None:
        pass

    def collect(self, sample: Sample, now: float) -> bool:
        self.calls += 1
        raise RuntimeError("collector bug")


def _sampler(*collectors, clock=None, **kw) -> ResourceSampler:
    clock = clock or FakeClock()
    return ResourceSampler(collectors=list(collectors), clock=clock, wall=clock, interval=15.0, **kw)


# ── Window aggregate ───────────────────────────────────────────────────────


def test_gauges_counters_and_rebaseline() -> None:
    clock = FakeClock()

    class C:
        name, capability, every, expensive = "c", "c", 0.0, False
        values = iter([(5.0, 100.0), (7.0, 130.0), (6.0, 10.0), (9.0, 25.0)])

        def reset(self):
            pass

        def collect(self, sample, now):
            g, c = next(self.values)
            sample.gauge("process.threads", g)
            sample.counter("container.memory.oom_kill", c)
            return True

    s = _sampler(C(), clock=clock)
    s.register(KEY)
    for _ in range(4):
        s.sample_now()
        clock.t += 15
    block = s.drain(KEY)
    assert block["n"] == 4
    assert block["window_s"] == 60
    assert block["process"]["threads"] == {"min": 5, "avg": 6.75, "max": 9, "last": 9}
    # 100 -> 130 (+30), then a reset to 10 is re-baselined (never -120), then +15.
    assert block["container"]["memory"]["oom_kill"] == 45


def test_unmeasured_values_are_absent_never_zero() -> None:
    class OnlyRss:
        name, capability, every, expensive = "m", "process.memory", 0.0, False

        def reset(self):
            pass

        def collect(self, sample, now):
            sample.gauge("process.memory.rss", 1024)
            sample.gauge("process.memory.pss", None)
            sample.gauge("process.fds", float("nan"))
            return True

    s = _sampler(OnlyRss())
    s.register(KEY)
    s.sample_now()
    block = s.drain(KEY)
    assert block["process"] == {"memory": {"rss": {"min": 1024, "avg": 1024, "max": 1024, "last": 1024}}}
    for absent in ("container", "runtime", "pools", "processes"):
        assert absent not in block


def test_empty_window_sends_no_block() -> None:
    s = _sampler(Fixed())
    s.register(KEY)
    assert s.drain(KEY) is None


def _shape_errors(ours, golden, path="resources") -> list[str]:
    errors: list[str] = []
    if isinstance(ours, dict):
        if not isinstance(golden, dict):
            return [f"{path}: object where the fixture has {type(golden).__name__}"]
        for key, value in ours.items():
            if key not in golden:
                errors.append(f"{path}.{key}: not in the fixture")
            elif golden[key] is not None:
                errors += _shape_errors(value, golden[key], f"{path}.{key}")
    elif isinstance(ours, list):
        if not isinstance(golden, list):
            return [f"{path}: list where the fixture has {type(golden).__name__}"]
        if golden:
            merged = {}
            for item in golden:
                if isinstance(item, dict):
                    merged.update(item)
            for i, item in enumerate(ours):
                errors += _shape_errors(item, merged or golden[0], f"{path}[{i}]")
    elif isinstance(ours, bool) or isinstance(golden, bool):
        if type(ours) is not type(golden):
            errors.append(f"{path}: {ours!r} vs fixture {golden!r}")
    elif isinstance(golden, (int, float)):
        if not isinstance(ours, (int, float)):
            errors.append(f"{path}: {ours!r} is not a number")
    elif type(ours) is not type(golden):
        errors.append(f"{path}: {ours!r} vs fixture {golden!r}")
    return errors


def test_payload_validates_against_the_golden_fixture_shape() -> None:
    golden = json.loads(GOLDEN.read_text())
    clock = FakeClock()
    s = _sampler(Fixed(), clock=clock)
    s._limit_source = "cgroup_v2"
    s.register(KEY)
    for _ in range(4):
        s.sample_now()
        clock.t += 15
    block = s.drain(KEY)
    assert _shape_errors(block, golden["resources"]) == []
    # Every top-level part of the fixture is produced (the shape is complete).
    assert set(block) == set(golden["resources"])
    assert block["v"] == 1 and block["limit_source"] == "cgroup_v2"
    assert block["container"]["cpu"]["throttled_ratio"] == 0.1
    assert block["runtime"]["python"]["gc"][0]["collections"] == 15
    assert block["runtime"]["python"]["gc"][0]["pause_ms_sum"] == 2
    assert block["runtime"]["python"]["gc"][0]["pause_ms_max"] == 1
    assert block["pools"][0]["used"] == {"min": 1, "avg": 2.5, "max": 4, "last": 4}
    assert block["sampler_cost_us"] >= 0


def test_real_sampler_payload_validates_against_the_fixture() -> None:
    golden = json.loads(GOLDEN.read_text())
    s = ResourceSampler(interval=15.0)
    s.register(KEY)
    s.sample_now()
    time.sleep(0.05)
    s.sample_now()
    block = s.drain(KEY)
    assert block is not None
    assert _shape_errors(block, golden["resources"]) == []
    assert "process.cpu" in block["capabilities"] and "runtime.python" in block["capabilities"]
    assert json.loads(json.dumps(block)) == block


# ── Isolation ──────────────────────────────────────────────────────────────


def test_a_raising_collector_never_stops_the_sampler() -> None:
    boom, fixed = Boom(), Fixed()
    s = _sampler(boom, fixed)
    s.register(KEY)
    for _ in range(8):
        s.sample_now()  # never raises
    assert boom.calls == 5  # turned off after 5 consecutive failures
    assert "boom" in s.disabled_collectors
    assert s.errors == {"boom": 5}
    assert fixed.calls == 8
    assert s.drain(KEY)["n"] == 8


def test_failures_must_be_consecutive() -> None:
    class Flaky(Boom):
        def collect(self, sample, now):
            self.calls += 1
            if self.calls % 4:
                raise RuntimeError("flaky")
            return True

    flaky = Flaky()
    s = _sampler(flaky)
    for _ in range(12):
        s.sample_now()
    assert "boom" not in s.disabled_collectors
    assert flaky.calls == 12


def test_a_raising_collector_on_the_thread_never_reaches_the_app() -> None:
    boom, fixed = Boom(), Fixed()
    s = ResourceSampler(collectors=[boom, fixed], interval=15.0)
    s.local_interval = 0.01
    s.register(KEY)
    s.start()
    try:
        deadline = time.monotonic() + 5
        while fixed.calls < 10 and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        s.stop()
    assert fixed.calls >= 10 and boom.calls == 5


def test_the_thread_is_a_daemon() -> None:
    s = ResourceSampler(collectors=[Fixed()], interval=15.0)
    s.start()
    try:
        threads = [t for t in threading.enumerate() if t.name == "apilens-resources"]
        assert threads and all(t.daemon for t in threads)
    finally:
        s.stop()


# ── Budget ─────────────────────────────────────────────────────────────────


def test_over_budget_drops_expensive_collectors_and_flags_the_window(monkeypatch) -> None:
    class Expensive(Fixed):
        name, capability, expensive = "process.pss", "process.pss", True

    cheap, costly = Fixed(), Expensive()
    s = _sampler(cheap, costly)
    s.register(KEY)
    times = iter(x * 1.0 for x in range(0, 1000, 1))  # 1 s of CPU per sample
    monkeypatch.setattr(sampler_mod, "_thread_time", lambda: next(times))
    s.sample_now()
    assert s.backoff
    s.sample_now()
    assert costly.calls == 1 and cheap.calls == 2
    assert "sampler_backoff" in s.drain(KEY)["flags"]
    # Cheap again: back under half the budget, the expensive one returns.
    monkeypatch.setattr(sampler_mod, "_thread_time", lambda: 0.0)
    for _ in range(40):
        s.sample_now()
    assert not s.backoff
    assert costly.calls > 1


def test_budget_is_a_tenth_of_a_percent_of_one_core() -> None:
    assert _sampler().budget_us() == 15_000  # 0.1 % of 15 s


# ── Serverless freeze ──────────────────────────────────────────────────────


def test_freeze_gap_flags_the_window_and_never_dilutes_cpu() -> None:
    from apilens.client.resources.process import ProcessCPU

    clock = FakeClock()

    class Ctx:
        cpu_limit = None

        def host_cores(self):
            return 2

    cpu = ProcessCPU(Ctx())
    s = _sampler(cpu, clock=clock)
    s.register(KEY)
    s.sample_now()  # baseline
    clock.t += 15
    s.sample_now()
    clock.t += 600  # frozen for 10 minutes: over 2x the interval
    s.sample_now()
    clock.t += 15
    s.sample_now()
    # Two CPU readings (after the baseline and after the re-baseline): none
    # is spread over the 600 s gap.
    assert s._windows[KEY].gauges["process.cpu.cores_used"][4] == 2
    block = s.drain(KEY)
    assert "freeze_gap" in block["flags"]
    assert block["n"] == 4
    assert s._windows[KEY].n == 0


# ── Fork ───────────────────────────────────────────────────────────────────


def _run(code: str, timeout: float = 60) -> dict:
    env = {**os.environ, "PYTHONPATH": str(SDK_ROOT)}
    out = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True, timeout=timeout, env=env
    )
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_fork_child_gets_a_fresh_window_pid_and_cpu_baseline() -> None:
    result = _run(
        """
        import json, os, time
        from apilens.client.resources import ResourceSampler
        s = ResourceSampler(interval=15.0)
        s.local_interval = 0.02
        s.register("k")
        s.start()
        t = time.process_time() + 0.3
        while time.process_time() < t:  # parent burns CPU the child must not inherit
            pass
        time.sleep(0.2)
        parent_n = s._windows["k"].n
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(r)
            fresh_n = s._windows["k"].n
            baseline = s.collectors[0]._prev
            s.ensure_running()
            time.sleep(0.3)
            block = s.drain("k")
            out = {
                "fresh_n": fresh_n,
                "baseline_cleared": baseline is None,
                "pid": s._pid == os.getpid(),
                "running": s.running,
                "n": block["n"] if block else 0,
                "cores_max": block["process"]["cpu"]["cores_used"]["max"],
            }
            os.write(w, json.dumps(out).encode())
            os._exit(0)
        os.close(w)
        data = b""
        while chunk := os.read(r, 65536):
            data += chunk
        os.waitpid(pid, 0)
        child = json.loads(data)
        child["parent_n"] = parent_n
        s.stop()
        print(json.dumps(child))
        """
    )
    assert result["parent_n"] > 0
    assert result["fresh_n"] == 0  # fresh window in the child
    assert result["baseline_cleared"]  # first CPU sample is a baseline
    assert result["pid"] and result["running"] and result["n"] > 0
    # The parent's 0.3 s of busy CPU never shows up as a child CPU spike.
    assert result["cores_max"] < 0.9


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_client_after_fork_restarts_sampling_and_new_instance() -> None:
    result = _run(
        """
        import json, os, time
        from apilens.client import ApiLensClient, ApiLensConfig
        c = ApiLensClient(ApiLensConfig(api_key="k", base_url="http://127.0.0.1:9/v1", send_heartbeat=False))
        c.resources.local_interval = 0.02
        parent = c.instance_id
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:
            child = c.instance_id  # the request path triggers the fork check
            time.sleep(0.2)
            out = {"parent": parent, "child": child, "sampling": c.resources.running,
                   "flush": c._thread is not None and c._thread.is_alive()}
            os.write(w, json.dumps(out).encode())
            os._exit(0)
        os.close(w)
        data = b""
        while chunk := os.read(r, 65536):
            data += chunk
        os.waitpid(pid, 0)
        c.shutdown(flush=False, timeout=0.1)
        print(data.decode())
        """
    )
    assert result["parent"] != result["child"]
    assert result["sampling"] and result["flush"]


# ── gevent ─────────────────────────────────────────────────────────────────


def test_gevent_patched_process_still_samples() -> None:
    pytest.importorskip("gevent")
    result = _run(
        """
        from gevent import monkey
        monkey.patch_all()
        import json, time, threading
        from apilens.client.resources import ResourceSampler
        s = ResourceSampler(interval=15.0)
        s.local_interval = 0.05
        s.register("k")
        s.start()
        # Block the hub (no gevent.sleep): a greenlet "thread" could not run.
        real_sleep = monkey.get_original("time", "sleep")
        real_sleep(0.6)
        block = s.drain("k")
        s.stop()
        print(json.dumps({"real": s._real is not None, "n": block["n"] if block else 0}))
        """
    )
    assert result["real"]
    assert result["n"] >= 3


# ── Remote policy ──────────────────────────────────────────────────────────


def test_policy_resources_is_parsed_and_only_narrows() -> None:
    p = parse_policy({"resources": {"enabled": False, "min_interval_s": 60, "disabled_collectors": ["processes", "bogus"]}})
    assert p.resources == ResourcesPolicy(False, 60.0, frozenset({"processes"}))
    assert parse_policy({}).resources == ResourcesPolicy()
    assert parse_policy({"resources": "nope"}).resources == ResourcesPolicy()

    s = _sampler(Fixed())
    s.apply_policy(ResourcesPolicy(min_interval_s=60))
    assert s.interval == 60
    s.apply_policy(ResourcesPolicy(min_interval_s=5))
    assert s.interval == 15  # never shorter than local


def test_policy_disables_sampling_and_collectors() -> None:
    fixed, boom = Fixed(), Fixed()
    boom.name = "processes"
    s = _sampler(fixed, boom)
    s.register(KEY)
    s.apply_policy(ResourcesPolicy(disabled_collectors=frozenset({"processes"})))
    s.sample_now()
    assert fixed.calls == 1 and boom.calls == 0
    s.apply_policy(ResourcesPolicy(enabled=False))
    s.sample_now()
    assert fixed.calls == 1
    assert s.drain(KEY) is None


# ── Client wiring ──────────────────────────────────────────────────────────


def test_capture_resources_false_starts_no_thread_and_sends_no_block() -> None:
    before = {t.ident for t in threading.enumerate() if t.name == "apilens-resources"}
    client = ApiLensClient(ApiLensConfig(api_key="k", app_id="orders-api", capture_resources=False))
    try:
        assert client.resources is None
        after = {t.ident for t in threading.enumerate() if t.name == "apilens-resources"}
        assert after == before
        assert "resources" not in client.heartbeat_payload("orders-api")
    finally:
        client.shutdown(flush=False, timeout=0.1)


def test_env_kill_switch(monkeypatch) -> None:
    monkeypatch.setenv("APILENS_CAPTURE_RESOURCES", "false")
    assert ApiLensConfig(api_key="k").capture_resources is False
    monkeypatch.setenv("APILENS_RESOURCES_INTERVAL", "30")
    assert ApiLensConfig(api_key="k").resources_interval == 30.0
    monkeypatch.setenv("APILENS_CAPTURE_PROCESS_LIST", "0")
    assert ApiLensConfig(api_key="k").capture_process_list is False


def test_resources_interval_minimum() -> None:
    with pytest.raises(ValueError, match="resources_interval"):
        ApiLensClient(ApiLensConfig(api_key="k", resources_interval=5), start_worker=False)


def test_heartbeat_carries_identity_and_resources() -> None:
    client = ApiLensClient(ApiLensConfig(api_key="k", app_id="orders-api"), start_worker=False)
    sampler = client.resources
    sampler.sample_now()
    time.sleep(0.02)
    sampler.sample_now()
    body = client.heartbeat_payload("orders-api")
    assert body["identity"]["platform"] in {"k8s", "ecs", "cloud_run", "app_engine", "heroku", "fly", "lambda", "vm", "bare"}
    assert body["identity"]["process_start_time"].endswith("Z")
    assert body["resources"]["v"] == 1 and body["resources"]["n"] == 2
    # Drained: the next heartbeat's window starts empty.
    assert "resources" not in client.heartbeat_payload("orders-api")


def test_heartbeat_response_policy_reaches_the_sampler() -> None:
    client = ApiLensClient(ApiLensConfig(api_key="k", app_id="orders-api"), start_worker=False)
    raw = json.dumps({"policy": {"enabled": True, "resources": {"enabled": True, "min_interval_s": 120, "disabled_collectors": ["pools"]}}}).encode()
    client._apply_heartbeat_response(raw, "orders-api")
    assert client.resources.interval == 120
    assert "pools" in client.resources.disabled_collectors
    raw = json.dumps({"policy": {"enabled": True, "resources": {"enabled": False}}}).encode()
    client._apply_heartbeat_response(raw, "orders-api")
    client.resources.sample_now()
    assert "resources" not in client.heartbeat_payload("orders-api")


def test_inline_mode_samples_on_flush_and_flags_serverless() -> None:
    client = ApiLensClient(
        ApiLensConfig(api_key="k", app_id="orders-api", mode="inline", send_heartbeat=False), start_worker=False
    )
    assert client.resources is not None and client.resources.serverless
    client.start()
    assert not client.resources.running  # no thread in inline mode
    client.flush()
    assert client.resources._windows[("orders-api", "production")].n == 1
    client.flush()  # not due yet
    assert client.resources._windows[("orders-api", "production")].n == 1
    block = client.resources.drain(("orders-api", "production"))
    assert "serverless" in block["flags"]
