"""``benchmarks/overhead.py`` (issue #537): the table it prints and the soft
threshold (warning annotation, exit 0 unless ``--fail-on-threshold``)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

SCRIPT = Path(__file__).resolve().parent.parent / "benchmarks" / "overhead.py"


@pytest.fixture(scope="module")
def bench():
    spec = importlib.util.spec_from_file_location("apilens_overhead_bench", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop(spec.name, None)


def _row(bench, body: str, profile: str, added: float | None):
    return bench.Row(
        body=body,
        profile=profile,
        p50_ms=1.0,
        p95_ms=2.0,
        p99_ms=3.0,
        added_p50_ms=added,
        added_p95_ms=added,
    )


def test_make_body_is_exact_size_json(bench) -> None:
    for size in bench.BODY_SIZES.values():
        body = bench.make_body(size)
        assert len(body) == size
        assert json.loads(body)["password"] == "hunter2"
    with pytest.raises(ValueError):
        bench.make_body(10)


def test_percentile_ms_nearest_rank(bench) -> None:
    samples = [i * 1_000_000 for i in range(1, 101)]  # 1..100 ms
    assert bench.percentile_ms(samples, 0.0) == 1.0
    assert bench.percentile_ms(samples, 0.5) == 51.0
    assert bench.percentile_ms(samples, 1.0) == 100.0


def test_main_prints_table_with_every_body_and_profile(bench, capsys, tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    out_md = tmp_path / "overhead.md"
    out_json = tmp_path / "overhead.json"
    code = bench.main(
        [
            "--iterations",
            "20",
            "--warmup",
            "2",
            "--rounds",
            "2",
            "--threshold-ms",
            "1000",
            "--output",
            str(out_md),
            "--json",
            str(out_json),
        ]
    )
    assert code == 0
    stdout = capsys.readouterr().out
    assert "| Body | Profile | p50 (ms) |" in stdout
    for body in bench.BODY_SIZES:
        for profile in (bench.BASELINE, *bench.PROFILES):
            assert f"| {body} | {profile} |" in stdout
    assert out_md.read_text() in stdout

    data = json.loads(out_json.read_text())
    assert data["passed"] is True
    assert data["threshold_ms"] == 1000
    assert len(data["rows"]) == len(bench.BODY_SIZES) * (1 + len(bench.PROFILES))
    for row in data["rows"]:
        if row["profile"] == bench.BASELINE:
            assert row["added_p50_ms"] is None
        else:
            assert isinstance(row["added_p50_ms"], float)


def test_threshold_only_checks_1kb_middleware_rows(bench) -> None:
    rows = [
        _row(bench, "1 KB", bench.BASELINE, None),
        _row(bench, "1 KB", "metadata", 0.1),
        _row(bench, "1 KB", "full", 0.5),
        _row(bench, "32 KB", "full", 9.0),
    ]
    assert [r.profile for r in bench.threshold_breaches(rows, 0.5)] == ["full"]
    assert bench.threshold_breaches(rows, 0.6) == []


def test_breach_is_a_warning_annotation_not_a_failure(bench, capsys, monkeypatch) -> None:
    rows = [_row(bench, "1 KB", bench.BASELINE, None), _row(bench, "1 KB", "full", 0.9)]

    async def fake_measure(iterations, warmup, rounds):
        return rows

    monkeypatch.setattr(bench, "measure", fake_measure)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    assert bench.main(["--iterations", "1"]) == 0
    out = capsys.readouterr().out
    assert "::warning title=SDK overhead threshold::full profile adds 0.900 ms p50 at 1 KB" in out

    assert bench.main(["--iterations", "1", "--fail-on-threshold"]) == 1
