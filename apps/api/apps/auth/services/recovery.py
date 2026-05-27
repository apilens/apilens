"""48-hour delayed 2FA recovery flow.

User has 2FA on, lost both the authenticator AND their backup codes. They
request a recovery, receive an email with confirm + cancel links, and have
48 hours to cancel if it wasn't them. After the cooldown elapses, the
confirm link disables 2FA, wipes backup codes, and revokes all sessions.
"""

import logging
import secrets

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.template.loader import render_to_string
from django.utils import timezone

from apps.users.models import User
from core.exceptions.base import RateLimitError, TokenExpiredError, TokenInvalidError

from ..models import BackupCode, RecoveryRequest, TOTPDevice
from ._constants import (
    RECOVERY_COOLDOWN,
    RECOVERY_GRACE,
    RECOVERY_RATE_LIMIT_WINDOW,
    hash_token,
)
from .tokens import TokenService

logger = logging.getLogger(__name__)


class RecoveryService:
    @staticmethod
    @transaction.atomic
    def request(email: str, ip_address: str | None = None) -> None:
        """Create a recovery request and email the link to the user.

        Silently no-ops when the email isn't an active 2FA account — prevents
        enumeration of 2FA-enabled users.
        """
        email = email.lower().strip()

        try:
            user = User.objects.get(email=email, is_active=True)
        except User.DoesNotExist:
            logger.info(f"Recovery request for non-existent email: {email}")
            return

        # Only relevant for users with 2FA on. Otherwise they can just sign in.
        if not TOTPDevice.objects.filter(user=user, is_verified=True).exists():
            logger.info(f"Recovery request for user without 2FA: {email}")
            return

        since = timezone.now() - RECOVERY_RATE_LIMIT_WINDOW
        recent = RecoveryRequest.objects.filter(user=user, requested_at__gte=since).count()
        if recent >= 1:
            raise RateLimitError("You can only request account recovery once per 24 hours.")

        # Latest request wins — invalidate any older pending one.
        RecoveryRequest.objects.filter(
            user=user, status=RecoveryRequest.STATUS_PENDING,
        ).update(status=RecoveryRequest.STATUS_CANCELLED)

        raw_token = secrets.token_urlsafe(48)
        now = timezone.now()
        available_at = now + RECOVERY_COOLDOWN
        expires_at = available_at + RECOVERY_GRACE

        RecoveryRequest.objects.create(
            user=user,
            token_hash=hash_token(raw_token),
            available_at=available_at,
            expires_at=expires_at,
            ip_address=ip_address,
        )

        frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
        confirm_url = f"{frontend_url}/auth/recovery?token={raw_token}"
        cancel_url = f"{frontend_url}/auth/recovery?token={raw_token}&action=cancel"

        from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai")
        context = {
            "email": user.email,
            "display_name": user.display_name or user.email,
            "confirm_url": confirm_url,
            "cancel_url": cancel_url,
            "available_at": available_at,
            "ip_address": ip_address or "Unknown",
            "cooldown_hours": int(RECOVERY_COOLDOWN.total_seconds() // 3600),
        }
        try:
            plain_text = render_to_string("auth/emails/recovery_requested.txt", context)
            html_content = render_to_string("auth/emails/recovery_requested.html", context)
            msg = EmailMultiAlternatives(
                subject="Account recovery requested for API Lens",
                body=plain_text,
                from_email=from_email,
                to=[email],
            )
            msg.attach_alternative(html_content, "text/html")
            msg.send(fail_silently=False)
            logger.info(f"Recovery email sent to {email}")
        except Exception as exc:
            # Don't roll back the RecoveryRequest — user can try again, but
            # log loudly because they may need to.
            logger.exception(f"Failed to send recovery email to {email}: {exc}")

    @staticmethod
    def get_status(raw_token: str) -> dict:
        """Public status lookup by token. Returns minimal info; never throws
        on bad tokens (avoids leaking which tokens exist)."""
        token_hash = hash_token(raw_token)
        try:
            req = RecoveryRequest.objects.select_related("user").get(token_hash=token_hash)
        except RecoveryRequest.DoesNotExist:
            return {"status": "invalid"}

        now = timezone.now()
        if req.status == RecoveryRequest.STATUS_CONFIRMED:
            return {"status": "confirmed", "email": req.user.email}
        if req.status == RecoveryRequest.STATUS_CANCELLED:
            return {"status": "cancelled", "email": req.user.email}
        if req.expires_at <= now:
            return {"status": "expired", "email": req.user.email}

        return {
            "status": "pending",
            "email": req.user.email,
            "requested_at": req.requested_at.isoformat(),
            "available_at": req.available_at.isoformat(),
            "expires_at": req.expires_at.isoformat(),
            "is_ready": req.available_at <= now,
        }

    @staticmethod
    @transaction.atomic
    def confirm(
        raw_token: str,
        ip_address: str | None = None,
        device_info: str | None = None,
    ) -> User:
        """After cooldown elapses: disable 2FA, wipe backup codes, revoke sessions."""
        from ..email import SecurityEmailService

        token_hash = hash_token(raw_token)
        try:
            req = (
                RecoveryRequest.objects.select_for_update()
                .select_related("user")
                .get(token_hash=token_hash)
            )
        except RecoveryRequest.DoesNotExist:
            raise TokenInvalidError("Invalid recovery link")

        if req.status != RecoveryRequest.STATUS_PENDING:
            raise TokenInvalidError("This recovery link has already been used or cancelled")

        now = timezone.now()
        if req.expires_at <= now:
            raise TokenExpiredError("This recovery link has expired. Request a new one.")
        if req.available_at > now:
            raise TokenInvalidError("The cooldown hasn't elapsed yet — check back later.")

        TOTPDevice.objects.filter(user=req.user).delete()
        BackupCode.objects.filter(user=req.user).delete()

        # Revoke active sessions so any attacker holding stolen tokens loses
        # them at the same moment 2FA is removed.
        TokenService.revoke_all_for_user(req.user)

        req.status = RecoveryRequest.STATUS_CONFIRMED
        req.save(update_fields=["status"])

        # Reuse the "2FA disabled" security email so the user gets the same
        # signal regardless of how 2FA went away.
        SecurityEmailService.send(
            req.user, "two_factor_disabled",
            ip_address=ip_address, device_info=device_info,
        )

        logger.info(f"Recovery confirmed for {req.user.email}; 2FA disabled")
        return req.user

    @staticmethod
    @transaction.atomic
    def cancel(raw_token: str) -> None:
        """One-click "this wasn't me". Idempotent and safe on a non-pending request."""
        token_hash = hash_token(raw_token)
        try:
            req = RecoveryRequest.objects.select_for_update().get(token_hash=token_hash)
        except RecoveryRequest.DoesNotExist:
            raise TokenInvalidError("Invalid recovery link")

        if req.status == RecoveryRequest.STATUS_CONFIRMED:
            raise TokenInvalidError(
                "This recovery has already been completed and can't be cancelled."
            )

        if req.status == RecoveryRequest.STATUS_PENDING:
            req.status = RecoveryRequest.STATUS_CANCELLED
            req.save(update_fields=["status"])
            logger.info(f"Recovery cancelled for {req.user.email}")
