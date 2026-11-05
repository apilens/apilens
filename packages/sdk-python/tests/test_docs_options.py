"""The README and the docs site list every option (issue #526).

A new middleware kwarg, ``ApiLensConfig`` field or ``APILENS_*`` variable
fails here until it has a row (name and default) in the configuration tables
of ``README.md`` and ``apps/docs/sdk-reference/python-configuration.mdx``.
"""

from __future__ import annotations

import dataclasses
import inspect
import re
from pathlib import Path

import pytest

from apilens.client import ApiLensConfig
from apilens.client._env import ENV_OPTIONS, env_var
from apilens.client.middleware import ApiLensASGIMiddleware, ApiLensWSGIMiddleware

SDK_ROOT = Path(__file__).resolve().parents[1]
README = SDK_ROOT / "README.md"
DOCS_PAGE = SDK_ROOT.parents[1] / "apps" / "docs" / "sdk-reference" / "python-configuration.mdx"

#: Constructor parameters that are plumbing, not options.
_NOT_OPTIONS = {"self", "app", "client"}


def _middleware_options() -> list[str]:
    names: set[str] = set()
    for cls in (ApiLensASGIMiddleware, ApiLensWSGIMiddleware):
        names.update(p for p in inspect.signature(inspect.unwrap(cls.__init__)).parameters if p not in _NOT_OPTIONS)
    return sorted(names)


def _config_options() -> list[str]:
    return [f.name for f in dataclasses.fields(ApiLensConfig)]


def _env_vars() -> list[str]:
    return [env_var(option) for option in ENV_OPTIONS]


def _table_rows(path: Path) -> str:
    if not path.exists():
        pytest.skip(f"{path} not in this checkout")
    return "".join(line for line in path.read_text(encoding="utf-8").splitlines(keepends=True) if line.startswith("|"))


def _missing(path: Path, names: list[str]) -> list[str]:
    rows = _table_rows(path)
    return [name for name in names if not re.search(r"`" + re.escape(name) + r"`", rows)]


@pytest.mark.parametrize("path", [README, DOCS_PAGE], ids=["README", "docs"])
def test_every_middleware_option_is_documented(path: Path) -> None:
    missing = _missing(path, _middleware_options())
    assert not missing, f"undocumented in {path.name}: {missing}"


@pytest.mark.parametrize("path", [README, DOCS_PAGE], ids=["README", "docs"])
def test_every_config_field_is_documented(path: Path) -> None:
    missing = _missing(path, _config_options())
    assert not missing, f"undocumented in {path.name}: {missing}"


@pytest.mark.parametrize("path", [README, DOCS_PAGE], ids=["README", "docs"])
def test_every_env_var_is_documented(path: Path) -> None:
    missing = _missing(path, _env_vars())
    assert not missing, f"undocumented in {path.name}: {missing}"


def test_checker_flags_an_undocumented_option(tmp_path: Path) -> None:
    page = tmp_path / "page.md"
    page.write_text("| `sample_rate` | `1.0` | x |\n\nprose mentions `exclude_paths` outside a table\n")
    assert _missing(page, ["sample_rate", "exclude_paths"]) == ["exclude_paths"]
