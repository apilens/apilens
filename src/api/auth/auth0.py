"""
Auth0 authentication for Django Ninja.
"""

from typing import Any

from django.http import HttpRequest
from ninja.security import HttpBearer

from core.auth.context import TenantContext


class Auth0Bearer(HttpBearer):
    """
    Authentication class for Django Ninja that validates Auth0 JWT tokens.

    Uses the TenantMiddleware to extract and validate tokens.

    Usage:
        from ninja import Router
        from api.auth.auth0 import Auth0Bearer

        router = Router(auth=Auth0Bearer())

        @router.get("/protected")
        def protected_endpoint(request):
            tenant = request.tenant
            return {"tenant_id": tenant.tenant_id}
    """

    def authenticate(self, request: HttpRequest, token: str) -> TenantContext | None:
        """
        Authenticate the request using the tenant context set by TenantMiddleware.

        Returns the TenantContext if authenticated, None otherwise.
        """
        # The TenantMiddleware has already validated the token
        # and attached the tenant context to the request
        tenant = getattr(request, "tenant", None)

        if tenant is None:
            return None

        return tenant


class OptionalAuth0Bearer(HttpBearer):
    """
    Optional authentication - allows both authenticated and unauthenticated requests.

    Use this for endpoints that behave differently based on auth status.
    """

    def authenticate(self, request: HttpRequest, token: str) -> TenantContext | None:
        """Return tenant context if available, None otherwise."""
        return getattr(request, "tenant", None)


def require_permission(permission: str):
    """
    Decorator to require a specific permission for an endpoint.

    Usage:
        @router.get("/admin-only")
        @require_permission("admin")
        def admin_endpoint(request):
            ...
    """
    def decorator(func):
        def wrapper(request, *args, **kwargs):
            tenant = getattr(request, "tenant", None)
            if tenant is None:
                from ninja.errors import HttpError
                raise HttpError(401, "Authentication required")

            if not tenant.has_permission(permission):
                from ninja.errors import HttpError
                raise HttpError(403, f"Permission '{permission}' required")

            return func(request, *args, **kwargs)
        return wrapper
    return decorator


def require_admin(func):
    """
    Decorator to require admin role for an endpoint.

    Usage:
        @router.get("/admin-only")
        @require_admin
        def admin_endpoint(request):
            ...
    """
    def wrapper(request, *args, **kwargs):
        tenant = getattr(request, "tenant", None)
        if tenant is None:
            from ninja.errors import HttpError
            raise HttpError(401, "Authentication required")

        if not tenant.is_admin():
            from ninja.errors import HttpError
            raise HttpError(403, "Admin access required")

        return func(request, *args, **kwargs)
    return wrapper
