"""Password-reset email + token verification + actual reset."""

import logging
import secrets
from datetime import timedelta

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.template.loader import render_to_string
from django.utils import timezone

from apps.users.models import User
from core.exceptions.base import AuthenticationError, RateLimitError, TokenExpiredError, TokenInvalidError

from ..models import PasswordResetToken
from ._constants import PASSWORD_RESET_LIFETIME, PASSWORD_RESET_RATE_LIMIT, hash_token
from .tokens import TokenService

logger = logging.getLogger(__name__)


class PasswordResetService:
    @staticmethod
    @transaction.atomic
    def create_and_send(email: str, ip_address: str | None = None) -> None:
        email = email.lower().strip()

        # Don't reveal whether the email exists. Just bail silently if not.
        try:
            user = User.objects.get(email=email, is_active=True)
        except User.DoesNotExist:
            logger.info(f"Password reset requested for non-existent user: {email}")
            return

        if not user.has_usable_password():
            # Magic-link-only account — there's no password to reset.
            logger.info(f"Password reset requested for magic-link-only user: {email}")
            return

        one_minute_ago = timezone.now() - timedelta(minutes=1)
        recent_count = PasswordResetToken.objects.filter(
            email=email, created_at__gte=one_minute_ago
        ).count()
        if recent_count >= PASSWORD_RESET_RATE_LIMIT:
            raise RateLimitError("Too many password reset requests. Please wait a moment.")

        raw_token = secrets.token_urlsafe(48)

        PasswordResetToken.objects.create(
            email=email,
            token_hash=hash_token(raw_token),
            expires_at=timezone.now() + PASSWORD_RESET_LIFETIME,
            ip_address=ip_address,
        )

        frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
        reset_url = f"{frontend_url}/auth/reset-password?token={raw_token}"

        from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai")
        context = {"reset_url": reset_url, "email": email}
        plain_text = render_to_string("auth/emails/password_reset.txt", context)
        html_content = render_to_string("auth/emails/password_reset.html", context)

        msg = EmailMultiAlternatives(
            subject="Reset your API Lens password",
            body=plain_text,
            from_email=from_email,
            to=[email],
        )
        msg.attach_alternative(html_content, "text/html")
        msg.send(fail_silently=False)

        logger.info(f"Password reset link sent to {email}")

    @staticmethod
    def verify_token(raw_token: str) -> str:
        """Verify a password reset token without consuming it. Returns the email."""
        token_hash = hash_token(raw_token)

        try:
            token_obj = PasswordResetToken.objects.get(token_hash=token_hash)
        except PasswordResetToken.DoesNotExist:
            raise TokenInvalidError("Invalid password reset link")

        if token_obj.is_used:
            raise TokenInvalidError("Password reset link has already been used")

        if token_obj.is_expired:
            raise TokenExpiredError("Password reset link has expired")

        return token_obj.email

    @staticmethod
    @transaction.atomic
    def reset_password(
        raw_token: str,
        new_password: str,
        invalidate_sessions: bool = True,
        ip_address: str | None = None,
    ) -> User:
        """Consume a token and set the new password. Optionally kills all sessions."""
        from ..email import SecurityEmailService

        token_hash = hash_token(raw_token)

        try:
            token_obj = PasswordResetToken.objects.get(token_hash=token_hash)
        except PasswordResetToken.DoesNotExist:
            raise TokenInvalidError("Invalid password reset link")

        if token_obj.is_used:
            raise TokenInvalidError("Password reset link has already been used")

        if token_obj.is_expired:
            raise TokenExpiredError("Password reset link has expired")

        token_obj.is_used = True
        token_obj.save(update_fields=["is_used"])

        try:
            user = User.objects.get(email=token_obj.email, is_active=True)
        except User.DoesNotExist:
            raise AuthenticationError("User account not found")

        user.set_password(new_password)
        user.save(update_fields=["password", "updated_at"])

        if invalidate_sessions:
            TokenService.revoke_all_for_user(user)
            logger.info(f"Revoked all sessions for user {user.email} after password reset")

        logger.info(f"Password reset successful for {user.email}")

        SecurityEmailService.send(
            user, "password_reset_success", ip_address=ip_address,
        )

        return user
