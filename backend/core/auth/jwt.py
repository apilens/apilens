import logging
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone

import jwt

from core.exceptions.base import TokenExpiredError, TokenInvalidError

logger = logging.getLogger(__name__)

TWOFA_CHALLENGE_LIFETIME = timedelta(minutes=5)


def create_access_token(payload: dict[str, Any]) -> str:
    return jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")


def verify_access_token(token: str) -> dict[str, Any]:
    try:
        claims = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=["HS256"],
            options={"require": ["sub", "email", "exp", "type"]},
        )
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
    return jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")


def verify_2fa_challenge_token(token: str) -> dict[str, Any]:
    try:
        claims = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=["HS256"],
            options={"require": ["sub", "email", "exp", "type"]},
        )
    except jwt.ExpiredSignatureError:
        raise TokenExpiredError("Sign-in session expired. Please log in again.")
    except jwt.InvalidTokenError:
        raise TokenInvalidError("Invalid sign-in session.")

    if claims.get("type") != "2fa_pending":
        raise TokenInvalidError("Invalid sign-in session.")

    return claims
