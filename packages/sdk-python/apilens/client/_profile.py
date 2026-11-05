"""``capture_profile`` presets: one greppable word for a capture posture.

A preset only changes the *defaults* of the capture flags below. Any flag set
explicitly (keyword argument, its own ``APILENS_*`` env var or Django setting)
wins over the preset. Precedence everywhere:

    explicit flag > the flag's env var / Django setting > capture_profile > default

=========================  ==========  ==========  ==========
flag                       metadata    redacted    full
=========================  ==========  ==========  ==========
capture_headers            False       True        True
log_request_body           False       True        True
log_response_body          False       True        True
capture_validation_errors  False       True        True
max_payload_bytes          (default)   16384       65536
=========================  ==========  ==========  ==========

``redacted`` relies on the built-in masking defaults (sensitive headers, query
params and body fields), which apply under every profile and cannot be
removed. ``full`` is the SDK's default posture, unchanged for backwards
compatibility; ``metadata`` is the recommended first production rollout.
"""

from __future__ import annotations

from typing import Any, Literal

CaptureProfile = Literal["metadata", "redacted", "full"]

#: Profile name -> the option defaults it sets.
CAPTURE_PROFILES: dict[str, dict[str, Any]] = {
    "metadata": {
        "capture_headers": False,
        "log_request_body": False,
        "log_response_body": False,
        "capture_validation_errors": False,
    },
    "redacted": {
        "capture_headers": True,
        "log_request_body": True,
        "log_response_body": True,
        "capture_validation_errors": True,
        "max_payload_bytes": 16384,
    },
    "full": {
        "capture_headers": True,
        "log_request_body": True,
        "log_response_body": True,
        "capture_validation_errors": True,
        "max_payload_bytes": 65536,
    },
}


def normalize_profile(value: Any, *, name: str = "capture_profile") -> str | None:
    """``None``/blank -> ``None``; a known profile name (any case) -> that name;
    anything else raises ``ValueError`` naming ``name``."""
    if value is None:
        return None
    raw = str(value).strip().lower()
    if not raw:
        return None
    if raw not in CAPTURE_PROFILES:
        raise ValueError(f"{name}: expected one of {', '.join(CAPTURE_PROFILES)}, got {value!r}")
    return raw


def profile_defaults(value: Any, *, name: str = "capture_profile") -> dict[str, Any]:
    """The option defaults ``value`` sets (empty for no profile)."""
    profile = normalize_profile(value, name=name)
    return dict(CAPTURE_PROFILES[profile]) if profile else {}


__all__ = ["CAPTURE_PROFILES", "CaptureProfile", "normalize_profile", "profile_defaults"]
