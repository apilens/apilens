"""Public surface of `apps.auth.services`.

Each Service class lives in its own module under this package. Existing
imports like `from apps.auth.services import TokenService` keep working
because every public name is re-exported here.
"""

from ._constants import (
    ACCESS_TOKEN_LIFETIME,
    API_KEY_PREFIX,
    MAGIC_LINK_LIFETIME,
    MAGIC_LINK_RATE_LIMIT,
    MAX_API_KEYS_PER_PROJECT,
    PASSWORD_LOGIN_LOCKOUT_WINDOW,
    PASSWORD_LOGIN_RATE_LIMIT,
    PASSWORD_RESET_LIFETIME,
    PASSWORD_RESET_RATE_LIMIT,
    RECOVERY_COOLDOWN,
    RECOVERY_GRACE,
    RECOVERY_RATE_LIMIT_WINDOW,
    REFRESH_TOKEN_LIFETIME,
    REFRESH_TOKEN_SESSION_LIFETIME,
)
from .api_keys import ApiKeyService
from .auth import AuthService
from .magic_link import MagicLinkService
from .passkey import PasskeyService
from .password_reset import PasswordResetService
from .recovery import RecoveryService
from .tokens import TokenService
from .two_factor import TwoFactorService

__all__ = [
    # Services
    "ApiKeyService",
    "AuthService",
    "MagicLinkService",
    "PasskeyService",
    "PasswordResetService",
    "RecoveryService",
    "TokenService",
    "TwoFactorService",
    # Constants (still imported by tests / other modules)
    "ACCESS_TOKEN_LIFETIME",
    "API_KEY_PREFIX",
    "MAGIC_LINK_LIFETIME",
    "MAGIC_LINK_RATE_LIMIT",
    "MAX_API_KEYS_PER_PROJECT",
    "PASSWORD_LOGIN_LOCKOUT_WINDOW",
    "PASSWORD_LOGIN_RATE_LIMIT",
    "PASSWORD_RESET_LIFETIME",
    "PASSWORD_RESET_RATE_LIMIT",
    "RECOVERY_COOLDOWN",
    "RECOVERY_GRACE",
    "RECOVERY_RATE_LIMIT_WINDOW",
    "REFRESH_TOKEN_LIFETIME",
    "REFRESH_TOKEN_SESSION_LIFETIME",
]
