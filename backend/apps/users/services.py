import logging
import os
from io import BytesIO
from typing import Optional

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone
from PIL import Image

from django.contrib.auth.password_validation import validate_password as django_validate_password
from django.core.exceptions import ValidationError as DjangoValidationError

from core.exceptions.base import AuthenticationError, ValidationError
from .models import User

logger = logging.getLogger(__name__)

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


class UserService:
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
    def update_profile(user: User, first_name: str | None = None, last_name: str | None = None) -> User:
        update_fields = []

        if first_name is not None:
            user.first_name = first_name[:150]
            update_fields.append("first_name")

        if last_name is not None:
            user.last_name = last_name[:150]
            update_fields.append("last_name")

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
        return user

    @staticmethod
    @transaction.atomic
    def update_picture(user: User, file) -> User:
        if file.content_type not in ALLOWED_IMAGE_TYPES:
            raise ValidationError("Only JPEG, PNG, and WebP images are allowed")

        max_size = getattr(settings, "PROFILE_PICTURE_MAX_SIZE", 5 * 1024 * 1024)
        if file.size > max_size:
            raise ValidationError(f"Image must be smaller than {max_size // (1024 * 1024)}MB")

        try:
            img = Image.open(file)
            img.verify()
            file.seek(0)
            img = Image.open(file)
        except Exception:
            raise ValidationError("Invalid image file")

        # Resize if needed
        max_dim = getattr(settings, "PROFILE_PICTURE_MAX_DIMENSION", 800)
        if img.width > max_dim or img.height > max_dim:
            img.thumbnail((max_dim, max_dim), Image.LANCZOS)

        # Convert to RGB (strip alpha) and save as JPEG
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")

        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=90)
        buffer.seek(0)

        # Delete old file if exists
        if user.picture:
            old_path = user.picture.path
            if os.path.exists(old_path):
                os.remove(old_path)

        user.picture.save(
            f"{user.id}.jpg",
            ContentFile(buffer.read()),
            save=False,
        )
        user.save(update_fields=["picture", "updated_at"])
        return user

    @staticmethod
    @transaction.atomic
    def remove_picture(user: User) -> User:
        if user.picture:
            try:
                old_path = user.picture.path
                if os.path.exists(old_path):
                    os.remove(old_path)
            except Exception:
                pass
            user.picture = ""
            user.save(update_fields=["picture", "updated_at"])
        return user
