"""Refresh-token issuance, rotation, revocation, and session enumeration."""

import logging
import secrets

from django.db import transaction
from django.utils import timezone

from apps.users.models import User
from core.auth.jwt import create_access_token as _encode_jwt
from core.exceptions.base import TokenExpiredError, TokenInvalidError
from core.utils.geoip import resolve_location

from ..models import MagicLinkToken, PasswordResetToken, RefreshToken
from ._constants import (
    ACCESS_TOKEN_LIFETIME,
    REFRESH_TOKEN_LIFETIME,
    REFRESH_TOKEN_SESSION_LIFETIME,
    hash_token,
)

logger = logging.getLogger(__name__)


class TokenService:
    @staticmethod
    def _normalized_device(device_info: str) -> str:
        return (device_info or "").strip()[:255]

    @staticmethod
    def _parse_user_agent(ua: str) -> dict[str, str]:
        """Parse a User-Agent string into stable {browser, os, device_type}.

        Returns a consistent identifier even if UA has minor variations across
        the same browser version (so sessions don't fragment on patch releases).
        """
        if not ua or len(ua) < 10:
            return {"browser": "", "os": "", "device_type": "desktop"}

        ua_lower = ua.lower()
        browser = ""
        os_name = ""
        device_type = "desktop"

        if any(x in ua_lower for x in ["iphone", "ipad", "android", "mobile"]):
            device_type = "mobile"

        # Browser detection — order matters (Edge contains "Chrome", Chrome contains "Safari").
        if "edg/" in ua_lower or "edge/" in ua_lower:
            browser = "edge"
        elif "chrome/" in ua_lower and "edg/" not in ua_lower:
            browser = "chrome"
        elif "firefox/" in ua_lower:
            browser = "firefox"
        elif "safari/" in ua_lower and "chrome/" not in ua_lower:
            browser = "safari"
        else:
            browser = "other"

        # OS detection — check mobile first so iOS doesn't get tagged as macOS.
        if "iphone" in ua_lower or "ipad" in ua_lower:
            os_name = "ios"
        elif "android" in ua_lower:
            os_name = "android"
        elif "mac os x" in ua_lower or "macintosh" in ua_lower:
            os_name = "macos"
        elif "windows" in ua_lower:
            os_name = "windows"
        elif "linux" in ua_lower:
            os_name = "linux"
        else:
            os_name = "other"

        return {"browser": browser, "os": os_name, "device_type": device_type}

    @staticmethod
    def _get_session_fingerprint(device_info: str, ip_address: str | None = None) -> str:
        """Stable fingerprint used to deduplicate sessions.

        Prefers parsed browser+OS so the same login from the same browser
        doesn't create N rows as the IP changes. Falls back to raw device_info,
        then to IP as a last resort.
        """
        parsed = TokenService._parse_user_agent(device_info)

        if parsed["browser"] and parsed["os"]:
            return f"{parsed['browser']}|{parsed['os']}|{parsed['device_type']}"

        normalized = TokenService._normalized_device(device_info)
        if normalized:
            return normalized

        return f"unknown|{ip_address or 'no-ip'}"

    @staticmethod
    def create_access_token(
        user: User,
        token_family: str | None = None,
        auth_method: str | None = None,
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
        user: User,
        device_info: str = "",
        ip_address: str | None = None,
        remember_me: bool = True,
    ) -> tuple[str, str]:
        raw_token = secrets.token_urlsafe(48)
        lifetime = REFRESH_TOKEN_LIFETIME if remember_me else REFRESH_TOKEN_SESSION_LIFETIME
        normalized_device = TokenService._normalized_device(device_info)

        # Deduplicate: revoke any existing tokens that share this session
        # fingerprint so the new one becomes the canonical session for this device.
        fingerprint = TokenService._get_session_fingerprint(device_info, ip_address)
        existing_tokens = RefreshToken.objects.for_user(user)
        for token in existing_tokens:
            token_fingerprint = TokenService._get_session_fingerprint(
                token.device_info, token.ip_address
            )
            if token_fingerprint == fingerprint:
                token.is_revoked = True
                token.save(update_fields=["is_revoked"])

        location = resolve_location(ip_address)

        token_obj = RefreshToken.objects.create(
            user=user,
            token_hash=hash_token(raw_token),
            expires_at=timezone.now() + lifetime,
            device_info=normalized_device,
            ip_address=ip_address,
            location=location,
        )
        return raw_token, str(token_obj.token_family)

    @staticmethod
    @transaction.atomic
    def rotate_refresh_token(raw_token: str) -> tuple[str, str, User]:
        token_hash = hash_token(raw_token)

        try:
            token_obj = RefreshToken.objects.select_related("user").get(token_hash=token_hash)
        except RefreshToken.DoesNotExist:
            raise TokenInvalidError("Invalid refresh token")

        # Reuse detection: if a previously-rotated token comes back, kill the
        # entire family. Either replay attack or a bug — neither is OK.
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

        token_obj.is_revoked = True
        token_obj.save(update_fields=["is_revoked"])

        user = token_obj.user
        new_raw = secrets.token_urlsafe(48)
        # Keep the same expiry — rotation is for replay protection, not lifetime extension.
        remaining = token_obj.expires_at - timezone.now()

        RefreshToken.objects.create(
            user=user,
            token_hash=hash_token(new_raw),
            token_family=token_obj.token_family,
            expires_at=timezone.now() + remaining,
            device_info=token_obj.device_info,
            ip_address=token_obj.ip_address,
            location=token_obj.location,
        )

        access_token = TokenService.create_access_token(
            user, token_family=str(token_obj.token_family)
        )
        return access_token, new_raw, user

    @staticmethod
    def revoke_token(raw_token: str) -> None:
        token_hash = hash_token(raw_token)
        RefreshToken.objects.filter(token_hash=token_hash).update(is_revoked=True)

    @staticmethod
    def revoke_all_for_user(user: User, except_family: str | None = None) -> int:
        qs = RefreshToken.objects.filter(user=user, is_revoked=False)
        if except_family:
            qs = qs.exclude(token_family=except_family)
        return qs.update(is_revoked=True)

    @staticmethod
    def revoke_session(user: User, session_id: str) -> bool:
        updated = RefreshToken.objects.filter(
            id=session_id, user=user, is_revoked=False
        ).update(is_revoked=True)
        return updated > 0

    @staticmethod
    def is_session_alive(raw_token: str) -> bool:
        token_hash = hash_token(raw_token)
        return RefreshToken.objects.filter(
            token_hash=token_hash, is_revoked=False, expires_at__gt=timezone.now()
        ).exists()

    @staticmethod
    def get_active_sessions(user: User) -> list[RefreshToken]:
        """One session per unique device (browser+OS). Most-recently-used wins."""
        rows = RefreshToken.objects.for_user(user).order_by("-last_used_at")
        seen_fingerprints: set[str] = set()
        result: list[RefreshToken] = []
        for row in rows:
            fingerprint = TokenService._get_session_fingerprint(row.device_info, row.ip_address)
            if fingerprint in seen_fingerprints:
                continue
            seen_fingerprints.add(fingerprint)
            result.append(row)
        return result

    @staticmethod
    def cleanup_expired() -> int:
        count, _ = RefreshToken.objects.cleanup_expired()
        ml_count, _ = MagicLinkToken.objects.cleanup_expired()
        pr_count, _ = PasswordResetToken.objects.cleanup_expired()
        return count + ml_count + pr_count
