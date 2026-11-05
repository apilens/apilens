"""Built-in default exclusions plus user-agent exclusion.

Health checks, load-balancer / Kubernetes probes and browser housekeeping files
(favicons, ``robots.txt``, ``/.well-known/...``) are excluded by default, the
same set Apitally skips. They are applied before the user's ``exclude_paths``;
``default_exclusions=False`` turns them off (``exclude_paths`` and
``exclude_user_agents`` still apply).

Every pattern is matched with ``re.search``, case-insensitively: paths against
the request path without the query string, user agents against the
``User-Agent`` header.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable

from ._exclude import PathExcluder, split_patterns

ENV_EXCLUDE_USER_AGENTS = "APILENS_EXCLUDE_USER_AGENTS"

#: Paths excluded by default (health checks, probes, static housekeeping files).
DEFAULT_EXCLUDED_PATHS: tuple[str, ...] = (
    r"/_?healthz?$",  # /health, /healthz, /_health, /_healthz
    r"/_?health[\-_]?checks?$",  # /health_checks, /health-check, /healthcheck
    r"/_?heart[\-_]?beats?$",  # /heartbeat, /heart-beats
    r"/ping$",
    r"/ready$",
    r"/live$",
    r"/favicon(?:-[\w-]+)?\.(?:ico|png|svg)$",
    r"/apple-touch-icon(?:-[\w-]+)?\.png$",
    r"/robots\.txt$",
    r"/sitemap\.xml$",
    r"/manifest\.json$",
    r"/site\.webmanifest$",
    r"/service-worker\.js$",
    r"/sw\.js$",
    r"/\.well-known/",
)

#: User agents excluded by default (load balancer and orchestrator probes).
DEFAULT_EXCLUDED_USER_AGENTS: tuple[str, ...] = (
    r"health[\-_ ]?check",
    r"microsoft-azure-application-lb",
    r"googlehc",
    r"kube-probe",
)


def env_exclude_user_agents() -> list[str]:
    """Patterns from the ``APILENS_EXCLUDE_USER_AGENTS`` env var (comma-separated)."""
    return split_patterns(os.environ.get(ENV_EXCLUDE_USER_AGENTS))


def _compile(patterns: Iterable[str]) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(p, re.IGNORECASE) for p in patterns)


def _strip_query(path: str | None) -> str:
    value = path or "/"
    q_index = value.find("?")
    return value[:q_index] if q_index != -1 else value


class RequestExcluder:
    """Decides whether a request bypasses capture entirely.

    Combines the built-in defaults (unless ``default_exclusions=False``), the
    user's ``exclude_paths`` (plus ``APILENS_EXCLUDE_PATHS``) and
    ``exclude_user_agents`` (plus ``APILENS_EXCLUDE_USER_AGENTS``). Everything
    is compiled once, here: an invalid regex raises :class:`re.error` at
    middleware construction, never per request.
    """

    __slots__ = ("default_exclusions", "default_paths", "paths", "user_agents")

    def __init__(
        self,
        exclude_paths: str | Iterable[str] | None = None,
        exclude_user_agents: str | Iterable[str] | None = None,
        *,
        default_exclusions: bool = True,
        include_env: bool = True,
    ) -> None:
        self.default_exclusions = bool(default_exclusions)
        self.default_paths: tuple[re.Pattern[str], ...] = (
            _compile(DEFAULT_EXCLUDED_PATHS) if self.default_exclusions else ()
        )
        self.paths = PathExcluder(exclude_paths, include_env=include_env)
        ua_sources = list(DEFAULT_EXCLUDED_USER_AGENTS) if self.default_exclusions else []
        ua_sources += split_patterns(exclude_user_agents)
        if include_env:
            ua_sources += env_exclude_user_agents()
        self.user_agents: tuple[re.Pattern[str], ...] = _compile(ua_sources)

    def __bool__(self) -> bool:
        return bool(self.default_paths or self.paths or self.user_agents)

    @property
    def checks_user_agent(self) -> bool:
        """True when the ``User-Agent`` matters (callers skip the header lookup otherwise)."""
        return bool(self.user_agents)

    def matches(self, path: str | None, user_agent: str | None = None) -> bool:
        """True when the request should not be captured at all."""
        if self.default_paths:
            value = _strip_query(path)
            if any(p.search(value) for p in self.default_paths):
                return True
        if self.paths.matches(path):
            return True
        if user_agent and self.user_agents:
            return any(p.search(user_agent) for p in self.user_agents)
        return False
