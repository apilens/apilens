"""
Webhook endpoints for external service callbacks.

These endpoints are called by Auth0 Actions, not by the frontend.
They use a shared secret for authentication instead of JWT.
"""

import hmac
import logging

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest
from ninja import Router
from ninja.errors import HttpError

from apps.users.models import User
from .schemas import Auth0UserSyncRequest, Auth0UserSyncResponse

logger = logging.getLogger(__name__)

router = Router(tags=["Webhooks"])


def verify_webhook_secret(request: HttpRequest) -> bool:
    """
    Verify the webhook request is from Auth0.

    Auth0 Action sends the secret in X-Webhook-Secret header.
    """
    expected_secret = getattr(settings, "AUTH0_WEBHOOK_SECRET", None)
    if not expected_secret:
        logger.error("AUTH0_WEBHOOK_SECRET not configured")
        return False

    provided_secret = request.headers.get("X-Webhook-Secret", "")

    # Use constant-time comparison to prevent timing attacks
    return hmac.compare_digest(expected_secret, provided_secret)


@router.post("/auth0/user-sync", response=Auth0UserSyncResponse)
def sync_user_from_auth0(request: HttpRequest, payload: Auth0UserSyncRequest):
    """
    Sync user from Auth0 Post-Login Action.

    Called by Auth0 on every login. Creates or updates user in Django.
    """
    # Verify webhook authenticity
    if not verify_webhook_secret(request):
        logger.warning(f"Invalid webhook secret for user sync: {payload.user_id}")
        raise HttpError(401, "Invalid webhook secret")

    auth0_id = payload.user_id
    email = payload.email.lower().strip()

    # Parse name
    first_name, last_name = "", ""
    if payload.name:
        parts = payload.name.strip().split(None, 1)
        first_name = parts[0][:150] if parts else ""
        last_name = parts[1][:150] if len(parts) > 1 else ""

    # Extract connection from auth0_id if not provided
    connection = payload.connection or ""
    if not connection and "|" in auth0_id:
        connection = auth0_id.split("|")[0]

    # Idempotent upsert - update or create user
    with transaction.atomic():
        user, created = User.objects.update_or_create(
            auth0_id=auth0_id,
            defaults={
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
                "picture": payload.picture or "",
                "email_verified": payload.email_verified,
                "auth0_connection": connection,
                "is_active": True,
            }
        )

    action = "created" if created else "updated"
    logger.info(f"User {action}: {email} [{auth0_id}]")

    return Auth0UserSyncResponse(
        success=True,
        user_id=str(user.id),
        created=created,
        message=f"User {action}",
    )
