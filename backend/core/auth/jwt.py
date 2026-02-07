"""
JWT validation and decoding for Auth0 tokens.

This module handles secure JWT validation using Auth0's JWKS endpoint.
It caches the public keys and validates token signatures, expiration,
audience, and issuer claims.
"""

import json
import logging
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Optional
from urllib.request import urlopen

from django.conf import settings
from django.core.cache import cache

import jwt
from jwt import PyJWKClient, PyJWK

logger = logging.getLogger(__name__)


class Auth0TokenError(Exception):
    """Base exception for Auth0 token errors."""
    pass


class TokenExpiredError(Auth0TokenError):
    """Token has expired."""
    pass


class TokenInvalidError(Auth0TokenError):
    """Token is invalid (signature, claims, etc.)."""
    pass


class JWTValidator:
    """
    Validates Auth0 JWT tokens.

    Uses Auth0's JWKS endpoint to fetch public keys for signature verification.
    Implements caching to avoid fetching keys on every request.
    """

    # Cache key for JWKS
    JWKS_CACHE_KEY = "auth0_jwks"
    JWKS_CACHE_TIMEOUT = 3600  # 1 hour

    def __init__(self):
        self.domain = settings.AUTH0_DOMAIN
        self.audience = settings.AUTH0_AUDIENCE
        self.algorithms = settings.AUTH0_ALGORITHMS
        self.issuer = f"https://{self.domain}/"
        self._jwks_client: Optional[PyJWKClient] = None

    @property
    def jwks_client(self) -> PyJWKClient:
        """Get or create JWKS client with caching."""
        if self._jwks_client is None:
            jwks_url = f"{self.issuer}.well-known/jwks.json"
            self._jwks_client = PyJWKClient(
                jwks_url,
                cache_keys=True,
                lifespan=self.JWKS_CACHE_TIMEOUT,
            )
        return self._jwks_client

    def validate_token(self, token: str) -> dict[str, Any]:
        """
        Validate an Auth0 JWT token.

        Args:
            token: The JWT token string (without 'Bearer ' prefix)

        Returns:
            dict: Decoded token claims

        Raises:
            TokenExpiredError: If token has expired
            TokenInvalidError: If token is invalid
        """
        try:
            # Get the signing key from JWKS
            signing_key = self.jwks_client.get_signing_key_from_jwt(token)

            # Decode and validate the token
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=self.algorithms,
                audience=self.audience,
                issuer=self.issuer,
                options={
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_aud": True,
                    "verify_iss": True,
                    "require": ["exp", "iss", "aud", "sub"],
                },
            )

            return claims

        except jwt.ExpiredSignatureError as e:
            logger.warning(f"Token expired: {e}")
            raise TokenExpiredError("Token has expired") from e

        except jwt.InvalidAudienceError as e:
            logger.warning(f"Invalid audience: {e}")
            raise TokenInvalidError("Invalid token audience") from e

        except jwt.InvalidIssuerError as e:
            logger.warning(f"Invalid issuer: {e}")
            raise TokenInvalidError("Invalid token issuer") from e

        except jwt.InvalidSignatureError as e:
            logger.warning(f"Invalid signature: {e}")
            raise TokenInvalidError("Invalid token signature") from e

        except jwt.DecodeError as e:
            logger.warning(f"Failed to decode token: {e}")
            raise TokenInvalidError("Failed to decode token") from e

        except Exception as e:
            logger.error(f"Unexpected error validating token: {e}")
            raise TokenInvalidError(f"Token validation failed: {e}") from e

    def decode_token_unverified(self, token: str) -> dict[str, Any]:
        """
        Decode token without verification (for debugging only).

        WARNING: Do not use this for authentication!
        """
        return jwt.decode(
            token,
            options={"verify_signature": False},
        )


# Global validator instance
_validator: Optional[JWTValidator] = None


def get_jwt_validator() -> JWTValidator:
    """Get the global JWT validator instance."""
    global _validator
    if _validator is None:
        _validator = JWTValidator()
    return _validator


def validate_token(token: str) -> dict[str, Any]:
    """Convenience function to validate a token."""
    return get_jwt_validator().validate_token(token)
