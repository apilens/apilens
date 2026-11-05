"""Path exclusion: skip capture entirely for health checks, probes, etc.

Shared by the ASGI, WSGI and Django middlewares so every framework matches
``exclude_paths`` the same way.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable

ENV_EXCLUDE_PATHS = "APILENS_EXCLUDE_PATHS"


def split_patterns(value: str | Iterable[str] | None) -> list[str]:
    """Normalize a pattern list given as a comma-separated string or an iterable.

    Blank entries are dropped. A string is split on commas, so a regex that
    needs a literal comma (``{1,3}``) must be passed as a list in code.
    """
    if value is None:
        return []
    items: Iterable[str] = value.split(",") if isinstance(value, str) else value
    return [str(p).strip() for p in items if str(p).strip()]


def env_exclude_paths() -> list[str]:
    """Patterns from the ``APILENS_EXCLUDE_PATHS`` env var (comma-separated)."""
    return split_patterns(os.environ.get(ENV_EXCLUDE_PATHS))


class PathExcluder:
    """Compiled ``exclude_paths`` regexes.

    Patterns are compiled once, at middleware construction — an invalid regex
    raises :class:`re.error` there, never per request. Each is matched with
    ``re.search``, case-insensitively, against the request path *without* the
    query string (the actual URL, not the route template), so ``^`` / ``$``
    anchor to the path: ``r"^/health$"`` excludes ``/health`` but not
    ``/healthz`` or ``/api/health``.

    Patterns from the ``APILENS_EXCLUDE_PATHS`` env var are added on top of the
    ones passed in code.
    """

    __slots__ = ("patterns",)

    def __init__(self, patterns: str | Iterable[str] | None = None, *, include_env: bool = True) -> None:
        sources = split_patterns(patterns)
        if include_env:
            sources += env_exclude_paths()
        self.patterns: tuple[re.Pattern[str], ...] = tuple(re.compile(p, re.IGNORECASE) for p in sources)

    def __bool__(self) -> bool:
        return bool(self.patterns)

    def matches(self, path: str | None) -> bool:
        """True when ``path`` (query string ignored) matches any pattern."""
        if not self.patterns:
            return False
        value = path or "/"
        q_index = value.find("?")
        if q_index != -1:
            value = value[:q_index]
        return any(p.search(value) for p in self.patterns)
