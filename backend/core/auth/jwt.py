import logging
from typing import Any

from django.conf import settings

import jwt

from core.exceptions.base import TokenExpiredError, TokenInvalidError

logger = logging.getLogger(__name__)


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
