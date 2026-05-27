import hashlib
import logging
from datetime import timedelta
from typing import Optional

from django.http import HttpRequest
from django.utils import timezone
from ninja.security import APIKeyHeader, HttpBearer

from apps.auth.models import ApiKey, RefreshToken
from apps.users.models import User
from core.auth.context import TenantContext
from core.auth.jwt import verify_access_token
from core.exceptions.base import TokenExpiredError, TokenInvalidError

logger = logging.getLogger(__name__)

# Skip last_used_at writes within this window to avoid a DB write per request.
_LAST_USED_DEBOUNCE = timedelta(seconds=60)


class JWTBearer(HttpBearer):
    def authenticate(self, request: HttpRequest, token: str) -> Optional[User]:
        try:
            claims = verify_access_token(token)

            user = User.objects.filter(id=claims["sub"], is_active=True).first()
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
            key_hash = hashlib.sha256(key.encode()).hexdigest()
            api_key = (
                ApiKey.objects.active()
                .select_related("project", "project__owner")
                .filter(
                    key_hash=key_hash,
                    project__is_active=True,
                    project__owner__is_active=True,
                )
                .first()
            )
            if api_key is None:
                return None

            user = api_key.project.owner
            request.tenant_context = TenantContext(
                tenant_id=str(user.id),
                user_id=str(user.id),
                email=user.email,
                project_id=str(api_key.project_id),
                project_slug=api_key.project.slug,
            )
            request._auth_method = "api_key"

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
