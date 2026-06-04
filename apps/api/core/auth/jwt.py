import logging
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone

import jwt

from core.auth import keys
from core.exceptions.base import TokenExpiredError, TokenInvalidError

logger = logging.getLogger(__name__)

TWOFA_CHALLENGE_LIFETIME = timedelta(minutes=5)

_REQUIRED_CLAIMS = ["sub", "email", "exp", "type"]


def _encode(payload: dict[str, Any]) -> str:
    """Sign with RS256 when a JWT private key is configured, else legacy HS256."""
    if keys.rsa_enabled():
        return jwt.encode(payload, keys.private_key(), algorithm="RS256", headers={"kid": keys.kid()})
    return jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")


def _decode(token: str) -> dict[str, Any]:
    """Verify by the token's own alg: RS256 → public key, HS256 → SECRET_KEY.

    Accepting both lets RS256 roll out while short-lived HS256 tokens drain.
    """
    alg = jwt.get_unverified_header(token).get("alg")
    if alg == "RS256":
        if not keys.rsa_enabled():
            raise TokenInvalidError()
        return jwt.decode(
            token, keys.public_key(), algorithms=["RS256"], options={"require": _REQUIRED_CLAIMS}
        )
    return jwt.decode(
        token, settings.SECRET_KEY, algorithms=["HS256"], options={"require": _REQUIRED_CLAIMS}
    )


def create_access_token(payload: dict[str, Any]) -> str:
    return _encode(payload)


def verify_access_token(token: str) -> dict[str, Any]:
    try:
        claims = _decode(token)
    except jwt.ExpiredSignatureError:
        raise TokenExpiredError()
    except jwt.InvalidTokenError:
        raise TokenInvalidError()

    if claims.get("type") != "access":
        raise TokenInvalidError("Not an access token")

    return claims


def create_2fa_challenge_token(user) -> str:
    """Short-lived token issued after password verification when 2FA is required.

    Lets the client complete the second factor without resubmitting the password.
    """
    now = timezone.now()
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "iat": now,
        "exp": now + TWOFA_CHALLENGE_LIFETIME,
        "type": "2fa_pending",
    }
    return _encode(payload)


def verify_2fa_challenge_token(token: str) -> dict[str, Any]:
    try:
        claims = _decode(token)
    except jwt.ExpiredSignatureError:
        raise TokenExpiredError("Sign-in session expired. Please log in again.")
    except jwt.InvalidTokenError:
        raise TokenInvalidError("Invalid sign-in session.")

    if claims.get("type") != "2fa_pending":
        raise TokenInvalidError("Invalid sign-in session.")

    return claims
