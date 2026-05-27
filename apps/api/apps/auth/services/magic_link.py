"""Email magic-link issuance + verification."""

import logging
import secrets
from datetime import timedelta

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.template.loader import render_to_string
from django.utils import timezone

from core.exceptions.base import RateLimitError, TokenExpiredError, TokenInvalidError

from ..models import MagicLinkToken
from ._constants import MAGIC_LINK_LIFETIME, MAGIC_LINK_RATE_LIMIT, hash_token

logger = logging.getLogger(__name__)


class MagicLinkService:
    @staticmethod
    @transaction.atomic
    def create_and_send(email: str, ip_address: str | None = None) -> None:
        email = email.lower().strip()

        one_minute_ago = timezone.now() - timedelta(minutes=1)
        recent_count = MagicLinkToken.objects.filter(
            email=email, created_at__gte=one_minute_ago
        ).count()
        if recent_count >= MAGIC_LINK_RATE_LIMIT:
            raise RateLimitError("Too many magic link requests. Please wait a moment.")

        raw_token = secrets.token_urlsafe(48)

        MagicLinkToken.objects.create(
            email=email,
            token_hash=hash_token(raw_token),
            expires_at=timezone.now() + MAGIC_LINK_LIFETIME,
            ip_address=ip_address,
        )

        frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
        verify_url = f"{frontend_url}/auth/verify?token={raw_token}"

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
        token_hash = hash_token(raw_token)

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
