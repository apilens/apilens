"""
Tenant middleware for multi-tenant authentication.
"""

import logging
from typing import Callable

from django.http import HttpRequest, HttpResponse, JsonResponse
from django.conf import settings

from core.auth.context import TenantContext

logger = logging.getLogger(__name__)


class TenantMiddleware:
    """
    Middleware that extracts tenant context from JWT tokens.

    Attaches a TenantContext object to request.tenant for authenticated requests.
    """

    # Paths that don't require authentication
    PUBLIC_PATHS = [
        "/api/v1/health/",
        "/api/v1/public/",
        "/admin/",
    ]

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        # Skip authentication for public paths
        if self._is_public_path(request.path):
            return self.get_response(request)

        # Skip if not an API request
        if not request.path.startswith("/api/"):
            return self.get_response(request)

        # Extract and validate JWT
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            # Allow request to proceed, but without tenant context
            # Individual views can require authentication
            request.tenant = None
            return self.get_response(request)

        token = auth_header[7:]  # Remove "Bearer " prefix

        try:
            tenant_context = self._decode_token(token)
            request.tenant = tenant_context
        except Exception as e:
            logger.warning("Invalid JWT token: %s", str(e))
            return JsonResponse(
                {"error": "Invalid or expired token"},
                status=401
            )

        return self.get_response(request)

    def _is_public_path(self, path: str) -> bool:
        """Check if the path is public and doesn't require auth."""
        return any(path.startswith(p) for p in self.PUBLIC_PATHS)

    def _decode_token(self, token: str) -> TenantContext:
        """
        Decode and validate JWT token, returning TenantContext.

        Uses Auth0 for token validation.
        """
        from jose import jwt, JWTError
        import httpx

        # Get Auth0 configuration
        domain = settings.AUTH0_DOMAIN
        audience = settings.AUTH0_AUDIENCE
        algorithms = settings.AUTH0_ALGORITHMS

        if not domain or not audience:
            raise ValueError("Auth0 configuration missing")

        # Get JWKS (JSON Web Key Set) from Auth0
        jwks_url = f"https://{domain}/.well-known/jwks.json"

        # In production, cache this response
        response = httpx.get(jwks_url, timeout=10)
        jwks = response.json()

        # Get the signing key
        unverified_header = jwt.get_unverified_header(token)
        rsa_key = {}

        for key in jwks["keys"]:
            if key["kid"] == unverified_header["kid"]:
                rsa_key = {
                    "kty": key["kty"],
                    "kid": key["kid"],
                    "use": key["use"],
                    "n": key["n"],
                    "e": key["e"],
                }
                break

        if not rsa_key:
            raise JWTError("Unable to find appropriate key")

        # Decode and validate token
        payload = jwt.decode(
            token,
            rsa_key,
            algorithms=algorithms,
            audience=audience,
            issuer=f"https://{domain}/",
        )

        # Extract tenant context from token claims
        # Adjust claim names based on your Auth0 configuration
        return TenantContext(
            tenant_id=payload.get("org_id", payload.get("sub", "")),
            user_id=payload.get("sub", ""),
            email=payload.get("email", ""),
            role=payload.get("role", "member"),
            permissions=payload.get("permissions", []),
        )
