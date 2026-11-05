"""The "Worked examples" on the masking docs page are true (issue #613).

Every row of the ``| Where | Sent | Stored |`` table in
``apps/docs/sdk-reference/masking.mdx`` is run through the SDK's default
masking, so the page cannot drift from what the SDK actually stores. The same
table is checked by the TypeScript SDK's ``tests/docs-masking.test.ts``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from apilens.client._sanitize import Redactor, serialize_headers

DOCS_PAGE = Path(__file__).resolve().parents[3] / "apps" / "docs" / "sdk-reference" / "masking.mdx"

_ROW = re.compile(r"^\| `(query|header|body|form)` \| `([^`]*)` \| `([^`]*)` \|$")


def _rows() -> list[tuple[str, str, str]]:
    if not DOCS_PAGE.exists():
        return []
    return [m.groups() for line in DOCS_PAGE.read_text(encoding="utf-8").splitlines() if (m := _ROW.match(line))]


ROWS = _rows()


def test_page_has_worked_examples() -> None:
    if not DOCS_PAGE.exists():
        pytest.skip(f"{DOCS_PAGE} not in this checkout")
    kinds = {kind for kind, _, _ in ROWS}
    assert kinds == {"query", "header", "body", "form"}, kinds


@pytest.mark.parametrize(("where", "sent", "stored"), ROWS, ids=[f"{w}:{s}" for w, s, _ in ROWS])
def test_worked_example(where: str, sent: str, stored: str) -> None:
    redactor = Redactor()
    if where == "query":
        assert redactor.redact_query(sent) == stored
    elif where == "form":
        assert redactor.redact_form(sent) == stored
    elif where == "body":
        assert json.loads(redactor.redact_body(sent)) == json.loads(stored)
    else:
        name, value = sent.split(": ", 1)
        want_name, want_value = stored.split(": ", 1)
        assert json.loads(serialize_headers({name: value}, redactor=redactor)) == {want_name: want_value}
