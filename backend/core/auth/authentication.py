"""
Django Ninja authentication classes for Auth0 JWT tokens.

This module provides authentication backends for Django Ninja that
validate Auth0 tokens and sync users automatically.
"""

import logging
from typing import Any, Optional

from django.http import HttpRequest
from ninja.security import HttpBearer

from apps.users.models import User
from apps.users.services import UserSyncService
from .jwt import (
    get_jwt_validator,
    TokenExpiredError,
    TokenInvalidError,
    Auth0TokenError,
)
from .context import TenantContext

logger = logging.getLogger(__name__)


class Auth0Bearer(HttpBearer):
    """
    Django Ninja authentication class for Auth0 JWT Bearer tokens.

    This class:
    1. Extracts the Bearer token from Authorization header
    2. Validates the token against Auth0 JWKS
    3. Creates or updates the Django user from token claims
    4. Attaches user and context to the request

    Usage in Django Ninja:
        from ninja import Router
        from core.auth.authentication import Auth0Bearer

        router = Router(auth=Auth0Bearer())

        @router.get("/protected")
        def protected_endpoint(request):
            user = request.auth  # Django User instance
            return {"email": user.email}
    """

    def authenticate(self, request: HttpRequest, token: str) -> Optional[User]:
        """
        Authenticate the request using Auth0 JWT token.

        Args:
            request: Django HTTP request
            token: JWT token (without 'Bearer ' prefix)

        Returns:
            User instance if authentication succeeds, None otherwise
        """
        try:
            # Validate the token
            validator = get_jwt_validator()
            claims = validator.validate_token(token)

            # Get or create user from token claims
            user = UserSyncService.get_or_create_from_token(claims)

            # Attach claims and context to request for later use
            request.token_claims = claims
            request.tenant_context = self._build_tenant_context(user, claims)

            logger.debug(f"Authenticated user: {user.email}")
            return user

        except TokenExpiredError:
            logger.warning("Authentication failed: token expired")
            return None

        except TokenInvalidError as e:
            logger.warning(f"Authentication failed: {e}")
            return None

        except Auth0TokenError as e:
            logger.error(f"Auth0 token error: {e}")
            return None

        except ValueError as e:
            logger.warning(f"Authentication failed: {e}")
            return None

        except Exception as e:
            logger.error(f"Unexpected authentication error: {e}")
            return None

    def _build_tenant_context(
        self, user: User, claims: dict[str, Any]
    ) -> TenantContext:
        """Build tenant context from user and claims."""
        # Extract permissions from claims if present
        # Auth0 can include custom claims like permissions
        permissions = claims.get("permissions", [])

        # Extract role from claims or default to member
        # This depends on your Auth0 rules/actions setup
        role = claims.get("https://apilens.io/role", "member")

        # For now, use user ID as tenant ID
        # In a multi-tenant setup, you'd extract this from claims
        tenant_id = claims.get("https://apilens.io/tenant_id", str(user.id))

        return TenantContext(
            tenant_id=tenant_id,
            user_id=str(user.id),
            email=user.email,
            role=role,
            permissions=permissions,
        )


class Auth0BearerOptional(Auth0Bearer):
    """
    Optional Auth0 Bearer authentication.

    Same as Auth0Bearer but allows unauthenticated requests.
    Returns None for request.auth if no valid token is provided.

    Usage:
        @router.get("/public", auth=Auth0BearerOptional())
        def public_endpoint(request):
            if request.auth:
                return {"message": f"Hello {request.auth.email}"}
            return {"message": "Hello anonymous"}
    """

    def authenticate(self, request: HttpRequest, token: str) -> Optional[User]:
        """Authenticate but don't fail on invalid token."""
        if not token:
            return None
        return super().authenticate(request, token)


# Convenience instances
auth0_auth = Auth0Bearer()
auth0_auth_optional = Auth0BearerOptional()
