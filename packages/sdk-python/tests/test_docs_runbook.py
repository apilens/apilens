"""Every log line the SDK runbook quotes exists in the SDK code (issue #616).

``apps/docs/guides/sdk-runbook.mdx`` quotes log lines in fenced blocks whose
info string is ``log <SDK>`` (``Python``, ``TypeScript`` or ``Java``), with
``<…>`` for the parts that vary. Each literal fragment between placeholders
must appear in that SDK's source, so a reworded log message fails here until
the runbook is updated.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
RUNBOOK = REPO / "apps" / "docs" / "guides" / "sdk-runbook.mdx"
SOURCES = {
    "Python": (REPO / "packages" / "sdk-python" / "apilens", "*.py"),
    "TypeScript": (REPO / "packages" / "sdk-typescript" / "src", "*.ts"),
    "Java": (REPO / "packages" / "sdk-java" / "src" / "main", "*.java"),
}

_BLOCK = re.compile(r"^```log (\w+)\n(.*?)^```", re.MULTILINE | re.DOTALL)
_PLACEHOLDER = re.compile(r"<[^<>]+>")
# A string literal continued on the next line: Python implicit concatenation
# ("a "\n "b"), Java and TypeScript "+" ("a " +\n "b", "a "\n + `b`).
_CONTINUATION = re.compile(r"""["'`]\s*\+?\s*\n\s*\+?\s*[a-zA-Z]{0,2}["'`]""")
# Shortest distinctive fragment a quoted line must contain.
_MIN_FRAGMENT = 15


def _quoted_lines() -> list[tuple[str, str]]:
    if not RUNBOOK.exists():
        pytest.skip(f"{RUNBOOK} not in this checkout")
    text = RUNBOOK.read_text(encoding="utf-8")
    lines = [
        (sdk, line.strip())
        for sdk, body in _BLOCK.findall(text)
        for line in body.splitlines()
        if line.strip()
    ]
    assert lines, f"no ```log blocks in {RUNBOOK.name}"
    return lines


def _source(sdk: str) -> str:
    root, pattern = SOURCES[sdk]
    if not root.exists():
        pytest.skip(f"{root} not in this checkout")
    text = "\n".join(p.read_text(encoding="utf-8") for p in sorted(root.rglob(pattern)))
    return _CONTINUATION.sub("", text)


def test_runbook_quotes_log_lines_of_every_sdk() -> None:
    assert {sdk for sdk, _ in _quoted_lines()} == set(SOURCES)


@pytest.mark.parametrize(("sdk", "line"), _quoted_lines() if RUNBOOK.exists() else [])
def test_quoted_log_line_exists_in_sdk_code(sdk: str, line: str) -> None:
    assert sdk in SOURCES, f"unknown SDK {sdk!r} in ```log {sdk}"
    source = _source(sdk)
    fragments = [f.strip() for f in _PLACEHOLDER.split(line) if f.strip()]
    assert max(map(len, fragments), default=0) >= _MIN_FRAGMENT, line
    missing = [f for f in fragments if f not in source]
    assert not missing, f"{sdk} code has no {missing!r} (quoted as: {line})"


def test_continuation_join() -> None:
    joined = _CONTINUATION.sub(
        "", 'x("is "\n    "being dropped", y)\n("a " +\n "b")\n(`c `\n + `d`)'
    )
    assert "is being dropped" in joined
    assert '"a b"' in joined
    assert "`c d`" in joined
