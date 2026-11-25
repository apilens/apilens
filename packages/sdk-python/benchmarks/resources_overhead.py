"""Cost of the runtime-resources sampler (M7, D11): resources on vs off.

Two measurements:

1. **CPU per sample.** A ``ResourceSampler`` with the default collectors is
   sampled ``--samples`` times. Its clock advances 60 s per sample, so every
   sample also runs the 60 s collectors (PSS, the process list): the worst
   case, not the average one. CPU is this thread's CPU time per
   ``sample_now()``. The share of a core is the mean cost over the production
   interval (15 s).
2. **Request latency.** A FastAPI echo endpoint is driven in-process through
   ASGI (as ``overhead.py`` does), first with no sampler, then with a sampler
   thread sampling every ``--stress-interval`` seconds (100 ms by default,
   150x the production rate) so its GIL time lands on requests. The table
   shows the latency added at p50/p95/p99.

Thresholds (D11, #1139): a median CPU per worst-case sample over
``--max-sample-ms`` (default 1 ms), or a mean share over ``--max-core-pct``
(default 0.1 % of one core at the 15 s interval), fails with exit 1. The
median, not p95, because a noisy neighbour on a shared runner moves the tail;
p95 and max are reported. The latency delta is
reported, never gated: in-process timings at 150x the sample rate on shared
runners are too noisy for a hard bar.

Usage (from ``packages/sdk-python``)::

    uv run --frozen --extra fastapi python benchmarks/resources_overhead.py \\
        --output resources-overhead.md --json resources-overhead.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import sys
import threading
import time
from typing import Any

os.environ.setdefault("APILENS_SEND_METADATA", "false")
os.environ.setdefault("APILENS_SEND_HEARTBEAT", "false")
os.environ.setdefault("APILENS_FLUSH_ON_SHUTDOWN", "false")

from apilens._version import __version__ as sdk_version
from apilens.client.resources import DEFAULT_INTERVAL_SECONDS, ResourceSampler
from fastapi import FastAPI, Request, Response

SLOW_EVERY_S = 60.0


class SteppingClock:
    """A monotonic clock that moves 60 s per read pair, so every collector
    (including the 60 s ones) is due on every sample."""

    def __init__(self) -> None:
        self.t = 1_000.0

    def tick(self) -> None:
        self.t += SLOW_EVERY_S

    def __call__(self) -> float:
        return self.t


def sample_costs(samples: int, warmup: int) -> tuple[list[float], ResourceSampler]:
    clock = SteppingClock()
    wall = SteppingClock()
    sampler = ResourceSampler(interval=SLOW_EVERY_S, clock=clock, wall=wall)
    sampler.register("bench")
    costs: list[float] = []
    for i in range(warmup + samples):
        clock.tick()
        wall.tick()
        t0 = time.thread_time()
        sampler.sample_now()
        cost_us = (time.thread_time() - t0) * 1e6
        if i >= warmup:
            costs.append(cost_us)
    return costs, sampler


def pct(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))]


def make_app() -> FastAPI:
    app = FastAPI()

    @app.post("/echo")
    async def echo(request: Request) -> Response:
        return Response(await request.body(), media_type="application/json")

    return app


async def call(app: Any, body: bytes) -> int:
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
        "headers": [(b"host", b"bench.local"), (b"content-type", b"application/json")],
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

    async def send(message: dict) -> None:
        return None

    start = time.perf_counter_ns()
    await app(scope, receive, send)
    return time.perf_counter_ns() - start


async def latencies(app: Any, n: int, body: bytes) -> list[int]:
    return [await call(app, body) for _ in range(n)]


def request_latency(
    iterations: int, rounds: int, stress_interval: float
) -> dict[str, dict[str, float]]:
    app = make_app()
    body = json.dumps({"pad": "x" * 1000}).encode()
    off: list[int] = []
    on: list[int] = []
    sampler = ResourceSampler(interval=DEFAULT_INTERVAL_SECONDS)
    sampler.register("bench")
    stop = threading.Event()
    running = threading.Event()

    def stress() -> None:
        while not stop.is_set():
            if running.is_set():
                sampler.sample_now()
            stop.wait(stress_interval)

    thread = threading.Thread(target=stress, daemon=True, name="bench-sampler")
    thread.start()
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(latencies(app, 500, body))
        per = max(1, iterations // rounds)
        # Interleave off/on rounds so drift hits both alike.
        for _ in range(rounds):
            running.clear()
            off.extend(loop.run_until_complete(latencies(app, per, body)))
            running.set()
            on.extend(loop.run_until_complete(latencies(app, per, body)))
    finally:
        stop.set()
        thread.join(timeout=2)
        loop.close()
    out: dict[str, dict[str, float]] = {}
    for name, values in (("off", off), ("on", on)):
        out[name] = {
            f"p{int(q * 100)}_ms": pct([v / 1e6 for v in values], q)
            for q in (0.5, 0.95, 0.99)
        }
    out["added"] = {k: out["on"][k] - out["off"][k] for k in out["off"]}
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--samples", type=int, default=300)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument(
        "--iterations", type=int, default=6000, help="requests per variant"
    )
    parser.add_argument("--rounds", type=int, default=6)
    parser.add_argument("--stress-interval", type=float, default=0.1)
    parser.add_argument("--max-sample-ms", type=float, default=1.0)
    parser.add_argument("--max-core-pct", type=float, default=0.1)
    parser.add_argument("--output")
    parser.add_argument("--json", dest="json_path")
    args = parser.parse_args(argv)

    costs, sampler = sample_costs(args.samples, args.warmup)
    mean_us = sum(costs) / len(costs)
    core_pct = mean_us / (DEFAULT_INTERVAL_SECONDS * 1e6) * 100
    lat = request_latency(args.iterations, args.rounds, args.stress_interval)
    result = {
        "sdk": "python",
        "sdk_version": sdk_version,
        "runtime": f"{platform.python_implementation()} {platform.python_version()}",
        "platform": f"{platform.system()} {platform.machine()}",
        "limit_source": sampler.limit_source,
        "capabilities": sampler.capabilities(),
        "sample_cpu_us": {
            "p50": pct(costs, 0.5),
            "p95": pct(costs, 0.95),
            "max": max(costs),
            "mean": mean_us,
        },
        "core_pct_at_15s": core_pct,
        "latency_ms": lat,
        "stress_interval_s": args.stress_interval,
    }
    breaches = []
    if result["sample_cpu_us"]["p50"] > args.max_sample_ms * 1000:
        breaches.append(
            f"median CPU per sample {result['sample_cpu_us']['p50']:.0f} us > {args.max_sample_ms} ms"
        )
    if core_pct > args.max_core_pct:
        breaches.append(
            f"sampler share {core_pct:.4f} % of a core > {args.max_core_pct} %"
        )
    result["breaches"] = breaches

    table = render(result)
    print(table)
    if args.output:
        with open(args.output, "w") as fh:
            fh.write(table)
    if args.json_path:
        with open(args.json_path, "w") as fh:
            json.dump(result, fh, indent=2)
    for b in breaches:
        prefix = "::error::" if os.environ.get("GITHUB_ACTIONS") else "FAIL "
        print(f"{prefix}resources sampler over budget: {b}", file=sys.stderr)
    return 1 if breaches else 0


def render(r: dict) -> str:
    s, lat = r["sample_cpu_us"], r["latency_ms"]
    return "\n".join(
        [
            f"### Python SDK resources sampler ({r['runtime']}, {r['platform']}, limit_source {r['limit_source']})",
            "",
            "| CPU per sample p50 | p95 | max | share of a core at 15 s |",
            "|---|---|---|---|",
            f"| {s['p50']:.0f} us | {s['p95']:.0f} us | {s['max']:.0f} us | {r['core_pct_at_15s']:.4f} % |",
            "",
            f"Request latency, sampler every {r['stress_interval_s'] * 1000:.0f} ms (150x production) vs off:",
            "",
            "| | p50 | p95 | p99 |",
            "|---|---|---|---|",
            f"| off | {lat['off']['p50_ms']:.3f} ms | {lat['off']['p95_ms']:.3f} ms | {lat['off']['p99_ms']:.3f} ms |",
            f"| on | {lat['on']['p50_ms']:.3f} ms | {lat['on']['p95_ms']:.3f} ms | {lat['on']['p99_ms']:.3f} ms |",
            f"| added | {lat['added']['p50_ms']:+.3f} ms | {lat['added']['p95_ms']:+.3f} ms | {lat['added']['p99_ms']:+.3f} ms |",
            "",
        ]
    )


if __name__ == "__main__":
    sys.exit(main())
