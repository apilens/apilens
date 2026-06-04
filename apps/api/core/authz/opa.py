"""Authorization decisions via the OPA policy decision point (CNCF OPA sidecar).

Services delegate the *decision* to OPA (policy-as-code), passing the subject +
action + resource attributes. The control-plane keeps its DB ownership filter as
defense-in-depth, so if OPA is unreachable we fail OPEN to that filter rather
than taking the whole dashboard down (the DB query already enforced ownership).

`check()` returns:
  True  → explicitly allowed
  False → explicitly denied
  None  → OPA unavailable (caller should fall back to its own guard)
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

_OPA_URL = os.environ.get("OPA_URL", "http://opa:8181/v1/data/apilens/authz/allow")
_TIMEOUT = float(os.environ.get("OPA_TIMEOUT_SECONDS", "3"))


def check(*, user_id: str, action: str, resource_type: str, owner_id: str) -> bool | None:
    payload = {
        "input": {
            "user_id": str(user_id or ""),
            "action": action,
            "resource": {"type": resource_type, "owner_id": str(owner_id or "")},
        }
    }
    req = urllib.request.Request(
        _OPA_URL,
        method="POST",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            result = json.loads(resp.read().decode()).get("result")
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        logger.warning("OPA authz unavailable (%s); falling back to DB guard", exc)
        return None
    return bool(result)


def enabled() -> bool:
    """OPA is consulted only when an OPA_URL is configured."""
    return bool(os.environ.get("OPA_URL", "").strip())
