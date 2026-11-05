"""Remote capture policy, received on every heartbeat (``POST /v1/heartbeat``).

The dashboard stores one policy per app (kill switch, sample rate, which
parts of a request are captured, a body cap) and ingest answers it on each
heartbeat, so capture can be turned down without a deploy. The client keeps
the last one per app as an immutable :class:`Policy`; the middlewares read
it on every request.

Remote can only make capture *narrower* than the local configuration: it can
disable capture, lower the sample rate, turn headers or bodies off and lower
the body cap. It can never turn on something the local config turned off,
and a locally disabled client (``enabled=False``) stays disabled. A failed or
unusable heartbeat keeps the last known policy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class Policy:
    """One app's capture policy. Every field only ever narrows local config."""

    # False: send nothing for the app (no records, spans or logs).
    enabled: bool = True
    # Upper bound on the fraction of requests whose detail is kept (0.0-1.0).
    sample_rate: float = 1.0
    capture_headers: bool = True
    capture_request_body: bool = True
    capture_response_body: bool = True
    # Upper bound on each captured body, in bytes; ``None`` means no remote cap.
    max_payload_bytes: int | None = None

    def cap_sample_rate(self, local: float) -> float:
        """The effective sample rate: the lower of ``local`` and the remote rate."""
        return min(local, self.sample_rate)

    def cap_payload_bytes(self, local: int) -> int:
        """The effective body cap: the lower of ``local`` and the remote cap."""
        if self.max_payload_bytes is None:
            return local
        return min(local, self.max_payload_bytes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "sample_rate": self.sample_rate,
            "capture_headers": self.capture_headers,
            "capture_request_body": self.capture_request_body,
            "capture_response_body": self.capture_response_body,
            "max_payload_bytes": self.max_payload_bytes,
        }


# No remote restriction: what an app captures before its first heartbeat.
ALLOW_ALL = Policy()
# Local ``enabled=False``: nothing remote can turn it back on.
DISABLED = Policy(
    enabled=False,
    sample_rate=0.0,
    capture_headers=False,
    capture_request_body=False,
    capture_response_body=False,
    max_payload_bytes=0,
)


def _flag(value: Any) -> bool:
    # Only an explicit JSON ``false`` narrows; a missing or malformed field
    # leaves that part of capture to the local config.
    return value is not False


def _rate(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(value):
        return 1.0
    return min(1.0, max(0.0, float(value)))


def _cap(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return max(0, int(value))


def parse_policy(data: Any) -> Policy | None:
    """The :class:`Policy` in a heartbeat response's ``policy`` object, or
    ``None`` when it is not an object (the caller keeps the previous one).
    Unusable fields impose no remote restriction."""
    if not isinstance(data, dict):
        return None
    return Policy(
        enabled=_flag(data.get("enabled")),
        sample_rate=_rate(data.get("sample_rate", 1.0)),
        capture_headers=_flag(data.get("capture_headers")),
        capture_request_body=_flag(data.get("capture_request_body")),
        capture_response_body=_flag(data.get("capture_response_body")),
        max_payload_bytes=_cap(data.get("max_payload_bytes")),
    )


def policy_for(client: Any, app_id: str) -> Policy:
    """``client.policy(app_id)``, or no restriction for a client without one
    (test doubles, custom clients). Never raises on the request path."""
    getter = getattr(client, "policy", None)
    if getter is None:
        return ALLOW_ALL
    try:
        policy = getter(app_id)
    except Exception:
        return ALLOW_ALL
    return policy if isinstance(policy, Policy) else ALLOW_ALL
