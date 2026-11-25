"""Platform and Kubernetes identity (issue #1100)."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from apilens.client.resources.cgroup import CgroupReader
from apilens.client.resources.identity import detect_platform, fetch_ecs_metadata, resolve_identity

TESTDATA = Path(__file__).resolve().parents[3] / "testdata" / "cgroup"
CID = "3f4e9c2b1a0d8e7f6c5b4a3928170f6e5d4c3b2a1908f7e6d5c4b3a291807f6e"
POD_UID = "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b"


def _ident(env: dict, root: str = "/nonexistent", case: str | None = None, **kw) -> dict:
    reader = CgroupReader(str(TESTDATA / case / "root")) if case else CgroupReader(root)
    return resolve_identity(env, root=root, cgroup=reader, hostname=kw.pop("hostname", "web-7d9c8b6f5-x2k4q"), **kw)


@pytest.mark.parametrize(
    ("env", "platform"),
    [
        ({"AWS_LAMBDA_FUNCTION_NAME": "orders"}, "lambda"),
        ({"KUBERNETES_SERVICE_HOST": "10.0.0.1"}, "k8s"),
        ({"K_SERVICE": "orders", "K_REVISION": "orders-001"}, "cloud_run"),
        ({"CLOUD_RUN_JOB": "nightly"}, "cloud_run"),
        ({"GAE_SERVICE": "default", "GAE_APPLICATION": "s~proj"}, "app_engine"),
        ({"ECS_CONTAINER_METADATA_URI_V4": "http://169.254.170.2/v4/x"}, "ecs"),
        ({"DYNO": "web.1"}, "heroku"),
        ({"FLY_APP_NAME": "orders", "FLY_MACHINE_ID": "abc"}, "fly"),
        ({}, "bare"),
    ],
)
def test_platform_matrix(env: dict, platform: str) -> None:
    assert detect_platform(env, "/nonexistent") == platform


def test_vm_detected_from_dmi(tmp_path: Path) -> None:
    dmi = tmp_path / "sys" / "class" / "dmi" / "id"
    dmi.mkdir(parents=True)
    (dmi / "sys_vendor").write_text("Google\n")
    assert detect_platform({}, str(tmp_path)) == "vm"


def test_kubernetes_downward_api() -> None:
    env = {
        "KUBERNETES_SERVICE_HOST": "10.0.0.1",
        "POD_NAME": "storefront-7d9c8b6f5-x2k4q",
        "POD_NAMESPACE": "shop",
        "NODE_NAME": "gke-prod-pool-1-a1b2c3",
        "POD_UID": POD_UID,
    }
    ident = _ident(env, case="v2_k8s_nested")
    assert ident["pod_name"] == "storefront-7d9c8b6f5-x2k4q"
    assert ident["hostname_guess"] is False
    assert ident["namespace"] == "shop" and ident["node_name"] == "gke-prod-pool-1-a1b2c3"
    assert ident["pod_uid"] == POD_UID
    assert ident["container_id"] == CID
    assert ident["platform"] == "k8s"


def test_kubernetes_without_downward_api_guesses_and_reads_files(tmp_path: Path) -> None:
    ns = tmp_path / "var" / "run" / "secrets" / "kubernetes.io" / "serviceaccount"
    ns.mkdir(parents=True)
    (ns / "namespace").write_text("shop\n")
    reader = CgroupReader(str(TESTDATA / "v2_k8s_nested" / "root"))
    ident = resolve_identity({"KUBERNETES_SERVICE_HOST": "10.0.0.1"}, root=str(tmp_path), cgroup=reader, hostname="web-1")
    assert ident["pod_name"] == "web-1" and ident["hostname_guess"] is True
    assert ident["namespace"] == "shop"
    assert ident["pod_uid"] == POD_UID  # from the cgroup path (pod8a6f..._...)
    assert "node_name" not in ident


def test_namespace_file_missing_is_absent() -> None:
    ident = _ident({"KUBERNETES_SERVICE_HOST": "10.0.0.1"})  # automountServiceAccountToken: false
    assert "namespace" not in ident


def test_cgroup_v2_namespace_container_id_from_mountinfo() -> None:
    ident = _ident({"KUBERNETES_SERVICE_HOST": "x"}, case="v2_namespaced_limited")
    assert ident["container_id"] == CID


def test_hostname_only_is_a_guess() -> None:
    ident = _ident({}, hostname="neels-macbook.local")
    assert ident["hostname"] == "neels-macbook.local"
    assert ident["hostname_guess"] is True
    assert ident["platform"] == "bare"
    for absent in ("pod_name", "pod_uid", "namespace", "node_name", "container_id"):
        assert absent not in ident


def test_region_and_start_time() -> None:
    ident = _ident({"AWS_LAMBDA_FUNCTION_NAME": "f", "AWS_REGION": "eu-west-1"})
    assert ident["region"] == "eu-west-1"
    start = datetime.strptime(ident["process_start_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert start <= datetime.now(tz=timezone.utc)


def _server(handler_body, delay: float = 0.0):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            time.sleep(delay)
            body = handler_body.encode()
            try:
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/v4/abc"


def test_ecs_metadata_container_id_and_region() -> None:
    doc = {"DockerId": "5a0d5ceddf6c44c1928d367a815d890f-1234567890", "Labels": {"com.amazonaws.ecs.task-arn": "arn:aws:ecs:us-east-2:123:task/c/5a0d"}}
    srv, uri = _server(json.dumps(doc))
    try:
        ident = _ident({"ECS_CONTAINER_METADATA_URI_V4": uri})
    finally:
        srv.shutdown()
    assert ident["platform"] == "ecs"
    assert ident["container_id"] == "5a0d5ceddf6c44c1928d367a815d890f-1234567890"
    assert ident["region"] == "us-east-2"


def test_ecs_metadata_failure_is_silent_and_bounded_to_1s() -> None:
    srv, uri = _server("{}", delay=3.0)
    try:
        t0 = time.monotonic()
        ident = _ident({"ECS_CONTAINER_METADATA_URI_V4": uri})
        took = time.monotonic() - t0
    finally:
        srv.shutdown()
    assert took < 1.5
    assert ident["platform"] == "ecs" and "container_id" not in ident
    assert fetch_ecs_metadata("http://127.0.0.1:9/v4/x") is None  # refused
    assert fetch_ecs_metadata("not a url") is None


def test_client_resolves_identity_once_per_process(monkeypatch) -> None:
    from apilens.client import ApiLensClient, ApiLensConfig
    from apilens.client.resources import identity as identity_mod

    calls = []
    real = identity_mod.resolve_identity

    def counting(*a, **kw):
        calls.append(1)
        return real(*a, **kw)

    monkeypatch.setattr("apilens.client.resources.resolve_identity", counting)
    client = ApiLensClient(ApiLensConfig(api_key="k", app_id="a"), start_worker=False)
    for _ in range(3):
        assert client.heartbeat_payload("a")["identity"]["hostname"]
    assert len(calls) == 1
