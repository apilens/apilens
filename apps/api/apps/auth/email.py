import logging
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.utils import timezone

from apps.users.models import User
from core.utils.geoip import resolve_location

logger = logging.getLogger(__name__)


# Subject lines kept here so callers don't need to know them.
_SUBJECTS = {
    "password_changed": "Your API Lens password was changed",
    "password_reset_success": "Your API Lens password has been reset",
    "two_factor_enabled": "Two-factor authentication enabled on your API Lens account",
    "two_factor_disabled": "Two-factor authentication disabled on your API Lens account",
    "backup_code_used": "A backup code was used to sign in to API Lens",
}


class SecurityEmailService:
    """Sends security-event notifications to users.

    All sends are best-effort: a failure here must never roll back the security
    action the email is reporting on. We log the failure and move on.
    """

    @staticmethod
    def send(
        user: User,
        event: str,
        extra_context: dict[str, Any] | None = None,
        ip_address: str | None = None,
        device_info: str | None = None,
    ) -> None:
        if event not in _SUBJECTS:
            logger.warning(f"Unknown security email event: {event}")
            return

        try:
            from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai")
            frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")

            context: dict[str, Any] = {
                "user": user,
                "email": user.email,
                "display_name": user.display_name or user.email,
                "timestamp": timezone.now(),
                "ip_address": ip_address or "Unknown",
                "location": resolve_location(ip_address) if ip_address else "",
                "device_info": (device_info or "").strip()[:255],
                "frontend_url": frontend_url,
                "settings_url": f"{frontend_url}/account/account",
                "reset_password_url": f"{frontend_url}/auth/login",
            }
            if extra_context:
                context.update(extra_context)

            template_dir = f"auth/emails/security/{event}"
            plain_text = render_to_string(f"{template_dir}.txt", context)
            html_content = render_to_string(f"{template_dir}.html", context)

            msg = EmailMultiAlternatives(
                subject=_SUBJECTS[event],
                body=plain_text,
                from_email=from_email,
                to=[user.email],
            )
            msg.attach_alternative(html_content, "text/html")
            msg.send(fail_silently=False)
            logger.info(f"Security email sent: event={event} to={user.email}")
        except Exception as exc:
            # Never propagate — the security action itself already succeeded.
            logger.exception(f"Failed to send security email {event} to {user.email}: {exc}")


class InvitationEmailService:
    """Sends a project invitation email. Best-effort (never rolls back the invite)."""

    @staticmethod
    def send(invitation, raw_token: str, inviter: User) -> None:
        try:
            from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai")
            frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
            inviter_name = (inviter.get_full_name() or "").strip() or inviter.email
            context = {
                "project_name": invitation.project.name,
                "role": invitation.role,
                "inviter_name": inviter_name,
                "email": invitation.email,
                "invite_url": f"{frontend_url}/auth/invite?token={raw_token}",
                "expires_at": invitation.expires_at,
                "frontend_url": frontend_url,
            }
            plain_text = render_to_string("auth/emails/invitation.txt", context)
            html_content = render_to_string("auth/emails/invitation.html", context)
            msg = EmailMultiAlternatives(
                subject=f"{inviter_name} invited you to {invitation.project.name} on API Lens",
                body=plain_text,
                from_email=from_email,
                to=[invitation.email],
            )
            msg.attach_alternative(html_content, "text/html")
            msg.send(fail_silently=False)
            logger.info(
                f"Invitation email sent to {invitation.email} for project {invitation.project_id}"
            )
        except Exception as exc:
            logger.exception(
                f"Failed to send invitation email to {invitation.email}: {exc}"
            )
