"""Single ``APILENS_*`` environment-variable config loader.

Every capture, masking, sampling and exclusion option can be set from the
environment, so a kill switch or a new redaction pattern never needs a code
change. Precedence everywhere: explicit keyword argument > env var > default.
Django settings of the same name win over the env var (see ``apilens.django``).

Value syntax:

* booleans accept ``1``/``0``/``true``/``false`` (also ``yes``/``no``/``on``/``off``),
  case-insensitive;
* lists are comma-separated (blank entries dropped), so a regex that needs a
  literal comma (``{1,3}``) must be passed as a list in code;
* an unset or empty variable is ignored; an unparseable value raises
  ``ValueError`` naming the variable, at startup.

Some variables keep their stricter, pre-existing semantics on top of this:
``APILENS_EXCLUDE_PATHS`` / ``APILENS_EXCLUDE_USER_AGENTS`` *add to* the
patterns passed in code, and ``APILENS_CAPTURE_SPANS=false``,
``APILENS_CAPTURE_IP=false`` and ``APILENS_ANONYMIZE_IP=true`` can only
tighten capture (they win over code in that direction).
"""

from __future__ import annotations

import functools
import inspect
import math
import os
from collections.abc import Callable, Mapping
from typing import Any, TypeVar

from ._exclude import split_patterns

ENV_PREFIX = "APILENS_"

_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})


def parse_bool(value: str, *, name: str = "value") -> bool:
    raw = value.strip().lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    raise ValueError(f"{name}: expected a boolean (1/0/true/false), got {value!r}")


def parse_int(value: str, *, name: str = "value") -> int:
    try:
        return int(value.strip())
    except ValueError:
        raise ValueError(f"{name}: expected an integer, got {value!r}") from None


def parse_float(value: str, *, name: str = "value") -> float:
    try:
        result = float(value.strip())
    except ValueError:
        raise ValueError(f"{name}: expected a number, got {value!r}") from None
    if math.isnan(result) or math.isinf(result):
        raise ValueError(f"{name}: expected a finite number, got {value!r}")
    return result


def parse_str(value: str, *, name: str = "value") -> str:
    return value.strip()


def parse_list(value: str, *, name: str = "value") -> list[str]:
    return split_patterns(value)


#: Option name -> parser. The env var is ``APILENS_`` + the upper-cased name.
ENV_OPTIONS: dict[str, Callable[..., Any]] = {
    "api_key": parse_str,
    "app_id": parse_str,
    "environment": parse_str,
    "base_url": parse_str,
    "enabled": parse_bool,
    "capture_headers": parse_bool,
    "capture_payloads": parse_bool,
    "log_request_body": parse_bool,
    "log_response_body": parse_bool,
    "max_payload_bytes": parse_int,
    "capture_content_types": parse_list,
    "redact_query_params": parse_list,
    "redact_headers": parse_list,
    "redact_body_fields": parse_list,
    "exclude_paths": parse_list,
    "exclude_user_agents": parse_list,
    "default_exclusions": parse_bool,
    "sample_rate": parse_float,
    "capture_ip": parse_bool,
    "anonymize_ip": parse_bool,
    "capture_spans": parse_bool,
    "batch_size": parse_int,
    "flush_interval": parse_float,
}

#: Options whose env var is merged by the component that owns it rather than
#: filled in as a default (exclusion patterns are additive, see ``_exclude``).
ADDITIVE_OPTIONS = frozenset({"exclude_paths", "exclude_user_agents"})

#: Keyword-argument spellings that mean the same option.
PARAM_ALIASES: dict[str, str] = {"env": "environment", "client_id": "api_key"}


def env_var(option: str) -> str:
    """``"sample_rate"`` -> ``"APILENS_SAMPLE_RATE"``."""
    return ENV_PREFIX + option.upper()


def load_env_config(environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Parse every ``APILENS_*`` option that is set (and non-empty).

    Returns ``{option_name: parsed_value}``, e.g. ``{"sample_rate": 0.25,
    "redact_headers": ["^x-secret$"]}``; unset variables are absent. Raises
    ``ValueError`` naming the variable for an unparseable value.
    """
    source = os.environ if environ is None else environ
    out: dict[str, Any] = {}
    for option, parser in ENV_OPTIONS.items():
        name = env_var(option)
        raw = source.get(name)
        if raw is None or not raw.strip():
            continue
        out[option] = parser(raw, name=name)
    return out


def _option_params(func: Callable[..., Any]) -> dict[str, list[str]]:
    """Option -> the parameter names of ``func`` that carry it."""
    by_option: dict[str, list[str]] = {}
    for param in inspect.signature(func).parameters:
        option = PARAM_ALIASES.get(param, param)
        if option in ENV_OPTIONS and option not in ADDITIVE_OPTIONS:
            by_option.setdefault(option, []).append(param)
    return by_option


def fill_from_env(
    func: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    env: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """``kwargs`` plus env values for every option ``func`` accepts that the
    call did not pass (positionally or by keyword, under any alias)."""
    env = load_env_config() if env is None else env
    if not env:
        return kwargs
    signature = inspect.signature(func)
    passed = signature.bind_partial(*args, **kwargs).arguments
    filled = dict(kwargs)
    for option, params in _option_params(func).items():
        if option not in env or any(p in passed for p in params):
            continue
        for param in params:
            filled[param] = env[option]
    return filled


F = TypeVar("F", bound=Callable[..., Any])


def env_defaults(func: F) -> F:
    """Decorate a constructor / ``instrument_*`` helper so every ``APILENS_*``
    option it accepts and the caller did not pass is read from the
    environment (explicit kwarg > env > the function's default)."""

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        return func(*args, **fill_from_env(func, args, kwargs))

    wrapper.__apilens_env_defaults__ = True  # type: ignore[attr-defined]
    return wrapper  # type: ignore[return-value]


def apply_env_defaults(cls: type) -> type:
    """Class decorator: wrap ``cls.__init__`` with :func:`env_defaults`
    (works for dataclasses, whose ``__init__`` is generated)."""
    cls.__init__ = env_defaults(cls.__init__)  # type: ignore[misc]
    return cls


__all__ = [
    "ADDITIVE_OPTIONS",
    "ENV_OPTIONS",
    "apply_env_defaults",
    "env_defaults",
    "env_var",
    "fill_from_env",
    "load_env_config",
]
