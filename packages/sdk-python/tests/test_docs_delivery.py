"""The delivery reference quotes the SDK's real defaults (issue #614).

``apps/docs/sdk-reference/delivery.mdx`` sizes queues and batches from the
defaults below; a changed default fails here until the page is updated.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from apilens.client import ApiLensConfig
from apilens.client import client as client_module

DOCS_PAGE = Path(__file__).resolve().parents[3] / "apps" / "docs" / "sdk-reference" / "delivery.mdx"
MB = 1024 * 1024


def _row(option: str) -> str:
    if not DOCS_PAGE.exists():
        pytest.skip(f"{DOCS_PAGE} not in this checkout")
    for line in DOCS_PAGE.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"| `{option}`"):
            return line
    raise AssertionError(f"no row for `{option}` in {DOCS_PAGE.name}")


def _num(value: float) -> str:
    return f"{value:,g}" if value < 1000 else f"{int(value):,}"


def test_defaults_table_matches_config() -> None:
    cfg = ApiLensConfig(api_key="apilens_test")
    assert f"`{cfg.batch_size}` records" in _row("batch_size")
    assert f"{cfg.max_batch_bytes // MB} MB" in _row("max_batch_bytes")
    assert f"{_num(cfg.flush_interval)} s" in _row("flush_interval")
    assert f"`{_num(cfg.max_queue_size)}` records per queue" in _row("max_queue_size")
    assert f"{cfg.max_queue_bytes // MB} MB" in _row("max_queue_bytes")
    assert cfg.compress is True
    assert f"level {client_module.GZIP_LEVEL}" in _row("compress")
    assert f"{_num(cfg.timeout)} s" in _row("timeout")
    assert f"`{cfg.max_retries}`" in _row("max_retries")
    assert f"{_num(cfg.retry_backoff_base)} s / {_num(cfg.retry_backoff_max)} s" in _row(
        "retry_backoff_base"
    )


def test_constants_quoted_in_prose_match() -> None:
    _row("batch_size")  # skips when the docs are not in this checkout
    text = DOCS_PAGE.read_text(encoding="utf-8")
    assert f"fixed {client_module.RECORD_OVERHEAD_BYTES} B" in text
    assert f"{client_module.MIN_BATCH_BYTES // 1024} KB in Python" in text
    assert f"capped at {_num(client_module.RETRY_AFTER_MAX_SECONDS)} s" in text
