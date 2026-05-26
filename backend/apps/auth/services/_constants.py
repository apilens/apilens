"""Shared timing constants and helpers used across the auth services.

Lives in `_constants` (leading underscore) to signal "package-private" — the
public surface is the service classes re-exported from `__init__`.
"""

import hashlib
from datetime import timedelta

ACCESS_TOKEN_LIFETIME = timedelta(minutes=15)
REFRESH_TOKEN_LIFETIME = timedelta(days=30)
REFRESH_TOKEN_SESSION_LIFETIME = timedelta(hours=24)

MAGIC_LINK_LIFETIME = timedelta(minutes=15)
MAGIC_LINK_RATE_LIMIT = 3  # per minute per email

PASSWORD_RESET_LIFETIME = timedelta(hours=1)
PASSWORD_RESET_RATE_LIMIT = 3  # per minute per email

PASSWORD_LOGIN_RATE_LIMIT = 10  # max attempts per 15-minute window per email
PASSWORD_LOGIN_LOCKOUT_WINDOW = 60 * 15  # seconds

# Account recovery: time between requesting recovery and being able to
# disable 2FA. Long enough for the legit account holder to receive the
# email and cancel if it wasn't them.
RECOVERY_COOLDOWN = timedelta(hours=48)
# Grace window after cooldown during which the recovery link still works.
RECOVERY_GRACE = timedelta(days=7)
# One request per user per day to prevent recovery-email spam.
RECOVERY_RATE_LIMIT_WINDOW = timedelta(days=1)

API_KEY_PREFIX = "apilens_"
MAX_API_KEYS_PER_PROJECT = 10


def hash_token(raw_token: str) -> str:
    """SHA-256 of the raw token. Used everywhere we store a token at rest."""
    return hashlib.sha256(raw_token.encode()).hexdigest()
