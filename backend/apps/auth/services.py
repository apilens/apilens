import hashlib
import logging
import secrets
from datetime import timedelta

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.db import transaction
from django.utils import timezone

from apps.users.models import User
from core.auth.jwt import create_access_token as _encode_jwt
from core.exceptions.base import (
    AuthenticationError,
    RateLimitError,
    TokenExpiredError,
    TokenInvalidError,
)

from core.utils.geoip import resolve_location
from .models import ApiKey, MagicLinkToken, RefreshToken

logger = logging.getLogger(__name__)

ACCESS_TOKEN_LIFETIME = timedelta(minutes=15)
REFRESH_TOKEN_LIFETIME = timedelta(days=30)
REFRESH_TOKEN_SESSION_LIFETIME = timedelta(hours=24)
MAGIC_LINK_LIFETIME = timedelta(minutes=15)
MAGIC_LINK_RATE_LIMIT = 3  # per minute per email


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()


class TokenService:
    @staticmethod
    def _normalized_device(device_info: str) -> str:
        return (device_info or "").strip()[:255]

    @staticmethod
    def create_access_token(
        user: User, token_family: str | None = None, auth_method: str | None = None,
    ) -> str:
        now = timezone.now()
        payload = {
            "sub": str(user.id),
            "email": user.email,
            "iat": now,
            "exp": now + ACCESS_TOKEN_LIFETIME,
            "type": "access",
        }
        if token_family:
            payload["tfm"] = str(token_family)
        if auth_method:
            payload["am"] = auth_method
        return _encode_jwt(payload)

    @staticmethod
    @transaction.atomic
    def create_refresh_token(
        user: User, device_info: str = "", ip_address: str | None = None,
        remember_me: bool = True,
    ) -> tuple[str, str]:
        raw_token = secrets.token_urlsafe(48)
        lifetime = REFRESH_TOKEN_LIFETIME if remember_me else REFRESH_TOKEN_SESSION_LIFETIME
        normalized_device = TokenService._normalized_device(device_info)

        # Revoke existing tokens from the same device to avoid duplicate entries in
        # active sessions. If device info is missing, fall back to IP-only dedupe.
        existing = RefreshToken.objects.for_user(user)
        if normalized_device:
            existing.filter(device_info=normalized_device).update(is_revoked=True)
        elif ip_address:
            existing.filter(ip_address=ip_address).update(is_revoked=True)

        location = resolve_location(ip_address)

        token_obj = RefreshToken.objects.create(
            user=user,
            token_hash=_hash_token(raw_token),
            expires_at=timezone.now() + lifetime,
            device_info=normalized_device,
            ip_address=ip_address,
            location=location,
        )
        return raw_token, str(token_obj.token_family)

    @staticmethod
    @transaction.atomic
    def rotate_refresh_token(raw_token: str) -> tuple[str, str, User]:
        token_hash = _hash_token(raw_token)

        try:
            token_obj = RefreshToken.objects.select_related("user").get(
                token_hash=token_hash
            )
        except RefreshToken.DoesNotExist:
            raise TokenInvalidError("Invalid refresh token")

        # Reuse detection: if token is already revoked, revoke the entire family
        if token_obj.is_revoked:
            RefreshToken.objects.filter(token_family=token_obj.token_family).update(
                is_revoked=True
            )
            logger.warning(
                f"Refresh token reuse detected for user {token_obj.user_id}, "
                f"family {token_obj.token_family}"
            )
            raise TokenInvalidError("Refresh token reuse detected")

        if token_obj.is_expired:
            raise TokenExpiredError("Refresh token has expired")

        # Revoke old token
        token_obj.is_revoked = True
        token_obj.save(update_fields=["is_revoked"])

        # Issue new tokens in the same family
        user = token_obj.user
        new_raw = secrets.token_urlsafe(48)
        remaining = token_obj.expires_at - timezone.now()

        RefreshToken.objects.create(
            user=user,
            token_hash=_hash_token(new_raw),
            token_family=token_obj.token_family,
            expires_at=timezone.now() + remaining,
            device_info=token_obj.device_info,
            ip_address=token_obj.ip_address,
            location=token_obj.location,
        )

        access_token = TokenService.create_access_token(user, token_family=str(token_obj.token_family))
        return access_token, new_raw, user

    @staticmethod
    def revoke_token(raw_token: str) -> None:
        token_hash = _hash_token(raw_token)
        RefreshToken.objects.filter(token_hash=token_hash).update(is_revoked=True)

    @staticmethod
    def revoke_all_for_user(user: User) -> int:
        return RefreshToken.objects.filter(
            user=user, is_revoked=False
        ).update(is_revoked=True)

    @staticmethod
    def revoke_session(user: User, session_id: str) -> bool:
        updated = RefreshToken.objects.filter(
            id=session_id, user=user, is_revoked=False
        ).update(is_revoked=True)
        return updated > 0

    @staticmethod
    def is_session_alive(raw_token: str) -> bool:
        """Check if a refresh token is still valid (not revoked/expired) without rotating."""
        token_hash = _hash_token(raw_token)
        return RefreshToken.objects.filter(
            token_hash=token_hash, is_revoked=False, expires_at__gt=timezone.now()
        ).exists()

    @staticmethod
    def get_active_sessions(user: User) -> list[RefreshToken]:
        # One visible session per device/IP fingerprint (latest activity wins).
        # This keeps the UI clean even if historical active rows exist.
        rows = (
            RefreshToken.objects.for_user(user)
            .order_by("-last_used_at")
        )
        seen_fingerprints: set[str] = set()
        result: list[RefreshToken] = []
        for row in rows:
            fingerprint = f"{TokenService._normalized_device(row.device_info)}|{row.ip_address or ''}"
            if fingerprint in seen_fingerprints:
                continue
            seen_fingerprints.add(fingerprint)
            result.append(row)
        return result

    @staticmethod
    def cleanup_expired() -> int:
        count, _ = RefreshToken.objects.cleanup_expired()
        ml_count, _ = MagicLinkToken.objects.cleanup_expired()
        return count + ml_count


class MagicLinkService:
    @staticmethod
    @transaction.atomic
    def create_and_send(
        email: str, ip_address: str | None = None, flow: str | None = None,
    ) -> None:
        email = email.lower().strip()

        # Rate limiting: max 3 per minute per email
        one_minute_ago = timezone.now() - timedelta(minutes=1)
        recent_count = MagicLinkToken.objects.filter(
            email=email, created_at__gte=one_minute_ago
        ).count()
        if recent_count >= MAGIC_LINK_RATE_LIMIT:
            raise RateLimitError("Too many magic link requests. Please wait a moment.")

        raw_token = secrets.token_urlsafe(48)

        MagicLinkToken.objects.create(
            email=email,
            token_hash=_hash_token(raw_token),
            expires_at=timezone.now() + MAGIC_LINK_LIFETIME,
            ip_address=ip_address,
        )

        frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
        verify_url = f"{frontend_url}/auth/verify?token={raw_token}"
        if flow:
            verify_url += f"&flow={flow}"

        from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai")
        context = {"verify_url": verify_url}
        plain_text = render_to_string("auth/emails/magic_link.txt", context)
        html_content = render_to_string("auth/emails/magic_link.html", context)

        msg = EmailMultiAlternatives(
            subject="Sign in to API Lens",
            body=plain_text,
            from_email=from_email,
            to=[email],
        )
        msg.attach_alternative(html_content, "text/html")
        msg.send(fail_silently=False)

        logger.info(f"Magic link sent to {email}")

    @staticmethod
    @transaction.atomic
    def verify(raw_token: str) -> str:
        token_hash = _hash_token(raw_token)

        try:
            token_obj = MagicLinkToken.objects.get(token_hash=token_hash)
        except MagicLinkToken.DoesNotExist:
            raise TokenInvalidError("Invalid magic link")

        if token_obj.is_used:
            raise TokenInvalidError("Magic link has already been used")

        if token_obj.is_expired:
            raise TokenExpiredError("Magic link has expired")

        token_obj.is_used = True
        token_obj.save(update_fields=["is_used"])

        return token_obj.email


class AuthService:
    @staticmethod
    def request_magic_link(
        email: str, ip_address: str | None = None, flow: str | None = None,
    ) -> None:
        MagicLinkService.create_and_send(email, ip_address, flow=flow)

    @staticmethod
    @transaction.atomic
    def verify_magic_link(
        raw_token: str, device_info: str = "", ip_address: str | None = None,
        remember_me: bool = True,
    ) -> tuple[str, str, User]:
        email = MagicLinkService.verify(raw_token)

        user, created = User.objects.get_or_create(
            email=email,
            defaults={
                "email_verified": True,
                "auth_provider": "magic_link",
                "is_active": True,
            },
        )

        if not user.email_verified:
            user.email_verified = True
            user.save(update_fields=["email_verified", "updated_at"])

        if created:
            user.set_unusable_password()
            user.save(update_fields=["password"])
            logger.info(f"New user created via magic link: {email}")

        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

        refresh_token, token_family = TokenService.create_refresh_token(
            user, device_info, ip_address, remember_me
        )
        access_token = TokenService.create_access_token(
            user, token_family=token_family, auth_method="magic_link",
        )

        return access_token, refresh_token, user

    @staticmethod
    @transaction.atomic
    def login_with_password(
        email: str, password: str, device_info: str = "",
        ip_address: str | None = None, remember_me: bool = True,
    ) -> tuple[str, str, User]:
        email = email.lower().strip()

        try:
            user = User.objects.get(email=email, is_active=True)
        except User.DoesNotExist:
            raise AuthenticationError("Invalid email or password")

        if not user.has_usable_password() or not user.check_password(password):
            raise AuthenticationError("Invalid email or password")

        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

        refresh_token, token_family = TokenService.create_refresh_token(
            user, device_info, ip_address, remember_me,
        )
        access_token = TokenService.create_access_token(
            user, token_family=token_family, auth_method="password",
        )

        return access_token, refresh_token, user

    @staticmethod
    def refresh_session(raw_refresh_token: str) -> tuple[str, str, User]:
        return TokenService.rotate_refresh_token(raw_refresh_token)

    @staticmethod
    def logout(raw_refresh_token: str) -> None:
        TokenService.revoke_token(raw_refresh_token)

    @staticmethod
    def logout_all(user: User) -> int:
        return TokenService.revoke_all_for_user(user)


API_KEY_PREFIX = "apilens_"
MAX_API_KEYS_PER_PROJECT = 10


class ApiKeyService:
    @staticmethod
    def create_key(project, name: str) -> tuple[str, ApiKey]:
        """Create a new API key for a project."""
        active_count = ApiKey.objects.for_project(project).count()
        if active_count >= MAX_API_KEYS_PER_PROJECT:
            raise RateLimitError(
                f"Maximum of {MAX_API_KEYS_PER_PROJECT} active API keys allowed per project"
            )

        raw_secret = secrets.token_urlsafe(40)
        raw_key = f"{API_KEY_PREFIX}{raw_secret}"
        prefix = raw_key[:16]

        api_key = ApiKey.objects.create(
            project=project,
            key_hash=_hash_token(raw_key),
            prefix=prefix,
            name=name[:100],
        )
        return raw_key, api_key

    @staticmethod
    def list_keys(project) -> list[ApiKey]:
        """List all active API keys for a project."""
        return list(ApiKey.objects.for_project(project).order_by("-created_at"))

    @staticmethod
    def revoke_key(project, key_id: str) -> bool:
        """Revoke a specific API key within a project."""
        updated = ApiKey.objects.filter(
            id=key_id, project=project, is_revoked=False
        ).update(is_revoked=True)
        return updated > 0

    @staticmethod
    def revoke_all_for_project(project) -> int:
        """Revoke all active API keys for a project."""
        return ApiKey.objects.filter(
            project=project, is_revoked=False
        ).update(is_revoked=True)
