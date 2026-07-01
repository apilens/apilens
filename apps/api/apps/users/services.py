import logging
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.utils import timezone

from django.contrib.auth.password_validation import validate_password as django_validate_password
from django.core.exceptions import ValidationError as DjangoValidationError

from core.exceptions.base import AuthenticationError, ValidationError
from .models import User

logger = logging.getLogger(__name__)


class UserService:
    @staticmethod
    def get_timezone(user: User) -> str:
        value = user.metadata.get("timezone") if isinstance(user.metadata, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip()
        return "UTC"

    @staticmethod
    def normalize_timezone(timezone_name: str | None) -> str:
        if timezone_name is None:
            raise ValidationError("Timezone is required")
        tz = timezone_name.strip()
        if not tz:
            raise ValidationError("Timezone is required")
        try:
            ZoneInfo(tz)
        except ZoneInfoNotFoundError as exc:
            raise ValidationError("Invalid timezone") from exc
        return tz

    @staticmethod
    @transaction.atomic
    def get_or_create_by_email(email: str, **defaults) -> tuple[User, bool]:
        return User.objects.get_or_create(
            email=email.lower().strip(),
            defaults={
                "email_verified": defaults.get("email_verified", False),
                "auth_provider": defaults.get("auth_provider", "magic_link"),
                "is_active": True,
            },
        )

    @staticmethod
    @transaction.atomic
    def update_profile(
        user: User,
        first_name: str | None = None,
        last_name: str | None = None,
        timezone_name: str | None = None,
    ) -> User:
        update_fields = []

        if first_name is not None:
            user.first_name = first_name[:150]
            update_fields.append("first_name")

        if last_name is not None:
            user.last_name = last_name[:150]
            update_fields.append("last_name")

        if timezone_name is not None:
            tz = UserService.normalize_timezone(timezone_name)
            meta = dict(user.metadata or {})
            if meta.get("timezone") != tz:
                meta["timezone"] = tz
                user.metadata = meta
                update_fields.append("metadata")

        if update_fields:
            user.save(update_fields=update_fields + ["updated_at"])

        return user

    @staticmethod
    @transaction.atomic
    def deactivate_user(user: User) -> None:
        user.is_active = False
        user.save(update_fields=["is_active", "updated_at"])

    @staticmethod
    def update_last_login(user: User) -> None:
        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

    @staticmethod
    def get_by_email(email: str) -> Optional[User]:
        try:
            return User.objects.get(email=email.lower().strip())
        except User.DoesNotExist:
            return None

    @staticmethod
    @transaction.atomic
    def set_password(
        user: User, new_password: str, current_password: str | None = None,
        auth_method: str | None = None,
        ip_address: str | None = None, device_info: str | None = None,
    ) -> User:
        # Require current password only if user already has one AND they didn't
        # authenticate via magic link (which serves as proof of email ownership).
        if user.has_usable_password() and auth_method != "magic_link":
            if not current_password:
                raise ValidationError("Current password is required")
            if not user.check_password(current_password):
                raise AuthenticationError("Current password is incorrect")

        try:
            django_validate_password(new_password, user)
        except DjangoValidationError as e:
            raise ValidationError("; ".join(e.messages))

        user.set_password(new_password)
        user.save(update_fields=["password", "updated_at"])

        # Invalidate all existing sessions so a compromised session can't
        # outlive the credential change. Caller issues fresh tokens for the
        # current device.
        from apps.auth.services import TokenService
        from apps.auth.email import SecurityEmailService
        TokenService.revoke_all_for_user(user)

        SecurityEmailService.send(
            user, "password_changed",
            ip_address=ip_address, device_info=device_info,
        )

        return user
