"""
Authentication module for APILens.

This module provides Auth0 JWT authentication for Django Ninja APIs.
"""

from .context import TenantContext
from .jwt import (
    JWTValidator,
    get_jwt_validator,
    validate_token,
    Auth0TokenError,
    TokenExpiredError,
    TokenInvalidError,
)
from .authentication import (
    Auth0Bearer,
    Auth0BearerOptional,
    auth0_auth,
    auth0_auth_optional,
)

__all__ = [
    "TenantContext",
    "JWTValidator",
    "get_jwt_validator",
    "validate_token",
    "Auth0TokenError",
    "TokenExpiredError",
    "TokenInvalidError",
    "Auth0Bearer",
    "Auth0BearerOptional",
    "auth0_auth",
    "auth0_auth_optional",
]
