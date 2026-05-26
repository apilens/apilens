"""Top-level orchestration: magic-link login, password login (incl. 2FA branch),
refresh, logout, logout-all. Routes call this; this calls into TokenService,
MagicLinkService, etc."""

import logging

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.users.models import User
from core.exceptions.base import AuthenticationError, MagicLinkOnlyError, RateLimitError

from ..models import TOTPDevice
from ._constants import PASSWORD_LOGIN_LOCKOUT_WINDOW, PASSWORD_LOGIN_RATE_LIMIT
from .magic_link import MagicLinkService
from .tokens import TokenService

logger = logging.getLogger(__name__)


class AuthService:
    @staticmethod
    def request_magic_link(email: str, ip_address: str | None = None) -> None:
        MagicLinkService.create_and_send(email, ip_address)

    @staticmethod
    @transaction.atomic
    def verify_magic_link(
        raw_token: str,
        device_info: str = "",
        ip_address: str | None = None,
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
        email: str,
        password: str,
        device_info: str = "",
        ip_address: str | None = None,
        remember_me: bool = True,
    ) -> tuple[str | None, str | None, User, bool]:
        """Verify password and either issue tokens or signal 2FA required.

        Returns (access_token, refresh_token, user, twofa_required). When
        `twofa_required` is True the tokens are None — caller must complete the
        second factor via /auth/2fa/exchange to receive real tokens.
        """
        email = email.lower().strip()
        cache_key = f"login_attempts:{email}"
        attempts = cache.get(cache_key, 0)
        if attempts >= PASSWORD_LOGIN_RATE_LIMIT:
            raise RateLimitError(
                "Too many login attempts. Please wait 15 minutes before trying again."
            )

        try:
            user = User.objects.get(email=email, is_active=True)
        except User.DoesNotExist:
            cache.set(cache_key, attempts + 1, PASSWORD_LOGIN_LOCKOUT_WINDOW)
            raise AuthenticationError("Invalid email or password")

        if not user.has_usable_password():
            cache.set(cache_key, attempts + 1, PASSWORD_LOGIN_LOCKOUT_WINDOW)
            raise MagicLinkOnlyError(
                "This account uses sign-in links. Use 'Email Link' instead."
            )

        if not user.check_password(password):
            cache.set(cache_key, attempts + 1, PASSWORD_LOGIN_LOCKOUT_WINDOW)
            raise AuthenticationError("Invalid email or password")

        cache.delete(cache_key)

        # 2FA gate — defer token issuance to the /auth/2fa/exchange step.
        has_2fa = TOTPDevice.objects.filter(user=user, is_verified=True).exists()
        if has_2fa:
            return None, None, user, True

        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

        refresh_token, token_family = TokenService.create_refresh_token(
            user, device_info, ip_address, remember_me,
        )
        access_token = TokenService.create_access_token(
            user, token_family=token_family, auth_method="password",
        )

        return access_token, refresh_token, user, False

    @staticmethod
    @transaction.atomic
    def complete_2fa_login(
        user: User,
        device_info: str = "",
        ip_address: str | None = None,
        remember_me: bool = True,
    ) -> tuple[str, str]:
        """Issue tokens after a successful 2FA challenge."""
        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

        refresh_token, token_family = TokenService.create_refresh_token(
            user, device_info, ip_address, remember_me,
        )
        access_token = TokenService.create_access_token(
            user, token_family=token_family, auth_method="password_2fa",
        )
        return access_token, refresh_token

    @staticmethod
    def refresh_session(raw_refresh_token: str) -> tuple[str, str, User]:
        return TokenService.rotate_refresh_token(raw_refresh_token)

    @staticmethod
    def logout(raw_refresh_token: str) -> None:
        TokenService.revoke_token(raw_refresh_token)

    @staticmethod
    def logout_all(user: User) -> int:
        return TokenService.revoke_all_for_user(user)
