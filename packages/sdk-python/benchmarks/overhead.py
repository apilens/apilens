"""Request-path overhead of the API Lens middleware on a FastAPI app.

Runs one FastAPI echo endpoint (``POST /echo``, JSON in and out) without the
middleware and with it under each ``capture_profile`` (``metadata``,
``redacted``, ``full``), at 1 KB and 32 KB bodies, and prints a markdown table
of per-request latency and the latency the middleware adds over the baseline.

The app is driven in-process through its ASGI interface, so the numbers are
the SDK's cost and not network or server noise. The client is real (record
building, masking, enqueueing, the flush thread serialising and gzipping
batches) except that the final POST to ingest is skipped.

Usage (from ``packages/sdk-python``)::

    uv run --frozen --extra fastapi python benchmarks/overhead.py
    uv run --frozen --extra fastapi python benchmarks/overhead.py \\
        --output overhead.md --json overhead.json

Threshold: the median added latency at 1 KB must stay under
``--threshold-ms`` (default 0.5 ms) for every profile. A breach prints a
warning (a GitHub ``::warning::`` annotation under Actions) and exits 0, unless
``--fail-on-threshold`` is passed.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import os
import platform
import sys
import time
from dataclasses import asdict, dataclass
from typing import Any

# Before importing the SDK: no metadata report, heartbeat or atexit flush
# towards a real ingest URL from a benchmark.
os.environ.setdefault("APILENS_SEND_METADATA", "false")
os.environ.setdefault("APILENS_SEND_HEARTBEAT", "false")
os.environ.setdefault("APILENS_FLUSH_ON_SHUTDOWN", "false")

from fastapi import FastAPI, Request, Response  # noqa: E402

from apilens._version import __version__ as sdk_version  # noqa: E402
from apilens.client import ApiLensClient, ApiLensConfig  # noqa: E402
from apilens.client.client import GZIP_LEVEL  # noqa: E402
from apilens.fastapi import ApiLensGatewayMiddleware  # noqa: E402

PROFILES = ("metadata", "redacted", "full")
BODY_SIZES = {"1 KB": 1024, "32 KB": 32 * 1024}
THRESHOLD_BODY = "1 KB"
DEFAULT_THRESHOLD_MS = 0.5
BASELINE = "baseline (no middleware)"


class NullTransportClient(ApiLensClient):
    """A real client whose final HTTP POST is a no-op (gzip still runs)."""

    def _post_body(self, path: str, body: bytes, *, read_response: bool = False) -> bytes:
        if self.config.compress:
            gzip.compress(body, compresslevel=GZIP_LEVEL)
        return b""


def make_body(size: int) -> bytes:
    """A JSON object of exactly ``size`` bytes with a few realistic fields
    (including ones the built-in masking redacts)."""
    head = {"id": 12345, "email": "user@example.com", "password": "hunter2", "items": []}
    base = json.dumps({**head, "pad": ""}, separators=(",", ":")).encode()
    if size < len(base):
        raise ValueError(f"body size {size} is smaller than the fixed fields ({len(base)})")
    body = json.dumps({**head, "pad": "x" * (size - len(base))}, separators=(",", ":")).encode()
    assert len(body) == size, (len(body), size)
    return body


def make_app(profile: str | None) -> tuple[FastAPI, ApiLensClient | None]:
    app = FastAPI()

    @app.post("/echo")
    async def echo(request: Request) -> Response:
        return Response(await request.body(), media_type="application/json")

    if profile is None:
        return app, None
    client = NullTransportClient(
        ApiLensConfig(api_key="bench-key", base_url="http://127.0.0.1:9/v1", environment="bench")
    )
    app.add_middleware(
        ApiLensGatewayMiddleware,
        client=client,
        app_id="bench",
        env="bench",
        capture_profile=profile,
        flush_on_shutdown=False,
    )
    return app, client


async def call(app: Any, body: bytes) -> int:
    """One POST /echo through the ASGI app; returns elapsed nanoseconds."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/echo",
        "raw_path": b"/echo",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"bench.local"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"user-agent", b"apilens-bench/1.0"),
            (b"authorization", b"Bearer secret-token"),
        ],
        "client": ("127.0.0.1", 50000),
        "server": ("bench.local", 80),
    }
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    status = 0

    async def send(message: dict) -> None:
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]

    start = time.perf_counter_ns()
    await app(scope, receive, send)
    elapsed = time.perf_counter_ns() - start
    if status != 200:
        raise RuntimeError(f"/echo returned {status}")
    return elapsed


@dataclass
class Row:
    body: str
    profile: str
    p50_ms: float
    p95_ms: float
    p99_ms: float
    added_p50_ms: float | None
    added_p95_ms: float | None


def percentile_ms(samples: list[int], q: float) -> float:
    """Nearest-rank percentile of nanosecond ``samples``, in milliseconds."""
    ordered = sorted(samples)
    idx = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[idx] / 1e6


async def measure(iterations: int, warmup: int, rounds: int) -> list[Row]:
    variants: list[str | None] = [None, *PROFILES]
    apps = {v: make_app(v) for v in variants}
    bodies = {label: make_body(size) for label, size in BODY_SIZES.items()}
    samples: dict[tuple[str, str | None], list[int]] = {
        (label, v): [] for label in bodies for v in variants
    }
    try:
        for body in bodies.values():
            for v in variants:
                for _ in range(warmup):
                    await call(apps[v][0], body)

        # Interleave variants in short rounds so drift (CPU frequency, noisy
        # neighbours) hits every variant alike instead of whichever ran last.
        per_round, extra = divmod(iterations, rounds)
        for i in range(rounds):
            n = per_round + (1 if i < extra else 0)
            for label, body in bodies.items():
                for v in variants:
                    app = apps[v][0]
                    bucket = samples[(label, v)]
                    for _ in range(n):
                        bucket.append(await call(app, body))
    finally:
        for _, client in apps.values():
            if client is not None:
                client.shutdown(flush=False, timeout=1.0)

    rows: list[Row] = []
    for label in bodies:
        base = samples[(label, None)]
        b50, b95 = percentile_ms(base, 0.50), percentile_ms(base, 0.95)
        for v in variants:
            s = samples[(label, v)]
            p50, p95 = percentile_ms(s, 0.50), percentile_ms(s, 0.95)
            rows.append(
                Row(
                    body=label,
                    profile=v or BASELINE,
                    p50_ms=p50,
                    p95_ms=p95,
                    p99_ms=percentile_ms(s, 0.99),
                    added_p50_ms=None if v is None else p50 - b50,
                    added_p95_ms=None if v is None else p95 - b95,
                )
            )
    return rows


def _fmt(value: float | None) -> str:
    return "-" if value is None else f"{value:.3f}"


def render_table(rows: list[Row], *, iterations: int) -> str:
    lines = [
        f"API Lens Python SDK {sdk_version}, Python {platform.python_version()}, "
        f"{platform.system()} {platform.machine()}, {iterations} requests per row",
        "",
        "| Body | Profile | p50 (ms) | p95 (ms) | p99 (ms) | Added p50 (ms) | Added p95 (ms) |",
        "|---|---|--:|--:|--:|--:|--:|",
    ]
    for r in rows:
        lines.append(
            f"| {r.body} | {r.profile} | {_fmt(r.p50_ms)} | {_fmt(r.p95_ms)} | "
            f"{_fmt(r.p99_ms)} | {_fmt(r.added_p50_ms)} | {_fmt(r.added_p95_ms)} |"
        )
    return "\n".join(lines) + "\n"


def threshold_breaches(rows: list[Row], threshold_ms: float) -> list[Row]:
    """Rows at ``THRESHOLD_BODY`` whose added p50 is at or over the threshold."""
    return [
        r
        for r in rows
        if r.body == THRESHOLD_BODY and r.added_p50_ms is not None and r.added_p50_ms >= threshold_ms
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--iterations", type=int, default=5000, help="timed requests per row")
    parser.add_argument("--warmup", type=int, default=300, help="untimed requests per row")
    parser.add_argument("--rounds", type=int, default=10, help="interleaved rounds")
    parser.add_argument("--threshold-ms", type=float, default=DEFAULT_THRESHOLD_MS)
    parser.add_argument(
        "--fail-on-threshold",
        action="store_true",
        help="exit 1 on a threshold breach (default: warn only)",
    )
    parser.add_argument("--output", help="also write the markdown table to this file")
    parser.add_argument("--json", dest="json_path", help="write the raw results as JSON here")
    args = parser.parse_args(argv)
    if args.iterations < 1 or args.rounds < 1 or args.warmup < 0:
        parser.error("--iterations and --rounds must be >= 1, --warmup >= 0")
    rounds = min(args.rounds, args.iterations)

    rows = asyncio.run(measure(args.iterations, args.warmup, rounds))
    table = render_table(rows, iterations=args.iterations)
    sys.stdout.write(table)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(table)

    breaches = threshold_breaches(rows, args.threshold_ms)
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "sdk_version": sdk_version,
                    "python": platform.python_version(),
                    "platform": f"{platform.system()} {platform.machine()}",
                    "iterations": args.iterations,
                    "threshold_ms": args.threshold_ms,
                    "threshold_body": THRESHOLD_BODY,
                    "passed": not breaches,
                    "rows": [asdict(r) for r in rows],
                },
                fh,
                indent=2,
            )
            fh.write("\n")

    for r in breaches:
        msg = (
            f"{r.profile} profile adds {r.added_p50_ms:.3f} ms p50 at {r.body} "
            f"(threshold {args.threshold_ms:g} ms)"
        )
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::warning title=SDK overhead threshold::{msg}")
        else:
            print(f"WARNING: {msg}", file=sys.stderr)
    return 1 if breaches and args.fail_on_threshold else 0


if __name__ == "__main__":
    raise SystemExit(main())
