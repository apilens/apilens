"""API-key authentication — ports apps/api ApiKeyAuth.

The key is project-level: hash → look up an active key whose project + owner are
active, and return that project. (Mirrors auth_api_keys / projects / users joins.)
"""

from __future__ import annotations

import hashlib

from .db import pg_conn

# Update last_used_at at most this often, matching the backend's debounce.
_LAST_USED_DEBOUNCE_SECONDS = 60


def authenticate(api_key: str) -> tuple[str, str] | None:
    """Return (project_id, project_slug) for a valid key, else None."""
    if not api_key:
        return None
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()
    with pg_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT k.id, k.project_id, p.slug
                FROM auth_api_keys k
                JOIN projects p ON p.id = k.project_id
                JOIN users u ON u.id = p.owner_id
                WHERE k.key_hash = %s
                  AND k.is_revoked = false
                  AND (k.expires_at IS NULL OR k.expires_at > now())
                  AND p.is_active = true
                  AND u.is_active = true
                LIMIT 1
                """,
                (key_hash,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            key_id, project_id, project_slug = row
            # Debounced last_used_at bump (avoids a write on every request).
            cur.execute(
                """
                UPDATE auth_api_keys
                SET last_used_at = now()
                WHERE id = %s
                  AND (last_used_at IS NULL
                       OR last_used_at < now() - interval '%s seconds')
                """,
                (key_id, _LAST_USED_DEBOUNCE_SECONDS),
            )
    return str(project_id), project_slug
