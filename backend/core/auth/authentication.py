import hashlib
import logging
from datetime import timedelta
from typing import Optional

from django.http import HttpRequest
from django.utils import timezone
from ninja.security import HttpBearer, APIKeyHeader

from apps.users.models import User
from core.exceptions.base import TokenExpiredError, TokenInvalidError

from .jwt import verify_access_token
from .context import TenantContext

logger = logging.getLogger(__name__)

# Only update last_used_at if more than 60s have passed (avoids DB write on every request)
_LAST_USED_DEBOUNCE = timedelta(seconds=60)


class JWTBearer(HttpBearer):
    def authenticate(self, request: HttpRequest, token: str) -> Optional[User]:
        try:
            claims = verify_access_token(token)

            user = User.objects.filter(
                id=claims["sub"], is_active=True
            ).first()
            if user is None:
                return None

            token_family = claims.get("tfm")
            request.token_claims = claims
            request._token_family = token_family
            request.tenant_context = TenantContext(
                tenant_id=str(user.id),
                user_id=str(user.id),
                email=user.email,
            )

            # Touch last_used_at on the session (debounced)
            if token_family:
                self._touch_session(token_family)

            return user

        except (TokenExpiredError, TokenInvalidError):
            return None
        except Exception as e:
            logger.error(f"Unexpected authentication error: {e}")
            return None

    @staticmethod
    def _touch_session(token_family: str) -> None:
        try:
            from apps.auth.models import RefreshToken
            now = timezone.now()
            threshold = now - _LAST_USED_DEBOUNCE
            RefreshToken.objects.filter(
                token_family=token_family,
                is_revoked=False,
                last_used_at__lt=threshold,
            ).update(last_used_at=now)
        except Exception:
            pass  # non-critical


class JWTBearerOptional(JWTBearer):
    def authenticate(self, request: HttpRequest, token: str) -> Optional[User]:
        if not token:
            return None
        return super().authenticate(request, token)


class ApiKeyAuth(APIKeyHeader):
    param_name = "X-API-Key"

    def authenticate(self, request: HttpRequest, key: Optional[str]) -> Optional[User]:
        if not key:
            return None

        try:
            from apps.auth.models import ApiKey

            key_hash = hashlib.sha256(key.encode()).hexdigest()
            api_key = (
                ApiKey.objects.active()
                .select_related("user")
                .filter(key_hash=key_hash, user__is_active=True)
                .first()
            )
            if api_key is None:
                return None

            user = api_key.user
            request.tenant_context = TenantContext(
                tenant_id=str(user.id),
                user_id=str(user.id),
                email=user.email,
            )
            request._auth_method = "api_key"

            # Touch last_used_at (debounced)
            now = timezone.now()
            if (
                api_key.last_used_at is None
                or api_key.last_used_at < now - _LAST_USED_DEBOUNCE
            ):
                ApiKey.objects.filter(id=api_key.id).update(last_used_at=now)

            return user
        except Exception as e:
            logger.error(f"API key authentication error: {e}")
            return None


jwt_auth = JWTBearer()
jwt_auth_optional = JWTBearerOptional()
api_key_auth = ApiKeyAuth()
