"""
User synchronization service for Auth0 integration.

This service handles creating and updating Django users based on
Auth0 JWT token claims. It's called on each authenticated request
to ensure user data stays in sync.
"""

import logging
from datetime import datetime
from typing import Any, Optional

from django.db import transaction
from django.utils import timezone

from .models import User

logger = logging.getLogger(__name__)


class UserSyncService:
    """
    Service for synchronizing Auth0 users with Django User model.

    This service is responsible for:
    - Creating new users when they first authenticate
    - Updating existing user data from Auth0 claims
    - Handling edge cases like email changes
    """

    @classmethod
    def get_or_create_from_token(cls, token_claims: dict[str, Any]) -> User:
        """
        Get or create a Django user from Auth0 JWT claims.

        Args:
            token_claims: Decoded JWT claims from Auth0 token.
                         Expected fields: sub, email, name, picture, email_verified, etc.

        Returns:
            User: The Django user instance (created or updated)

        Raises:
            ValueError: If required claims are missing
        """
        # Validate required claims
        auth0_id = token_claims.get("sub")
        if not auth0_id:
            raise ValueError("Missing 'sub' claim in token")

        email = token_claims.get("email")
        if not email:
            raise ValueError("Missing 'email' claim in token")

        # Try to get existing user by auth0_id
        try:
            user = User.objects.get(auth0_id=auth0_id)
            return cls._update_user_from_claims(user, token_claims)
        except User.DoesNotExist:
            pass

        # Check if user exists with same email but different auth0_id
        # This can happen with account linking
        try:
            user = User.objects.get(email=email)
            # Update the auth0_id if this is a linked account scenario
            logger.info(
                f"Found existing user with email {email}, updating auth0_id from {user.auth0_id} to {auth0_id}"
            )
            user.auth0_id = auth0_id
            return cls._update_user_from_claims(user, token_claims)
        except User.DoesNotExist:
            pass

        # Create new user
        return cls._create_user_from_claims(token_claims)

    @classmethod
    @transaction.atomic
    def _create_user_from_claims(cls, claims: dict[str, Any]) -> User:
        """Create a new user from Auth0 claims."""
        auth0_id = claims["sub"]
        email = claims["email"]

        # Parse name
        name = claims.get("name", "")
        first_name, last_name = cls._parse_name(name)

        # Extract connection from auth0_id
        connection = auth0_id.split("|")[0] if "|" in auth0_id else ""

        user = User.objects.create(
            auth0_id=auth0_id,
            email=email,
            first_name=first_name,
            last_name=last_name,
            picture=claims.get("picture", ""),
            email_verified=claims.get("email_verified", False),
            auth0_connection=connection,
            is_active=True,
        )

        logger.info(f"Created new user: {user.email} (auth0_id: {auth0_id})")
        return user

    @classmethod
    @transaction.atomic
    def _update_user_from_claims(cls, user: User, claims: dict[str, Any]) -> User:
        """Update existing user from Auth0 claims."""
        updated_fields = []

        # Update email if changed
        new_email = claims.get("email")
        if new_email and new_email != user.email:
            # Check if new email is already taken by another user
            if User.objects.filter(email=new_email).exclude(pk=user.pk).exists():
                logger.warning(
                    f"Cannot update email for user {user.auth0_id}: "
                    f"email {new_email} already exists"
                )
            else:
                user.email = new_email
                updated_fields.append("email")

        # Update name
        name = claims.get("name", "")
        first_name, last_name = cls._parse_name(name)
        if first_name and first_name != user.first_name:
            user.first_name = first_name
            updated_fields.append("first_name")
        if last_name and last_name != user.last_name:
            user.last_name = last_name
            updated_fields.append("last_name")

        # Update picture
        picture = claims.get("picture", "")
        if picture and picture != user.picture:
            user.picture = picture
            updated_fields.append("picture")

        # Update email_verified
        email_verified = claims.get("email_verified", False)
        if email_verified != user.email_verified:
            user.email_verified = email_verified
            updated_fields.append("email_verified")

        # Update last_synced_at (auto_now handles this)
        if updated_fields:
            user.save(update_fields=updated_fields + ["updated_at", "last_synced_at"])
            logger.debug(
                f"Updated user {user.email}: fields={updated_fields}"
            )

        return user

    @classmethod
    def update_last_login(cls, user: User) -> None:
        """Update the last login timestamp."""
        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

    @staticmethod
    def _parse_name(name: str) -> tuple[str, str]:
        """Parse full name into first and last name."""
        if not name:
            return "", ""

        parts = name.strip().split(None, 1)
        first_name = parts[0] if parts else ""
        last_name = parts[1] if len(parts) > 1 else ""

        return first_name[:150], last_name[:150]

    @classmethod
    def get_by_auth0_id(cls, auth0_id: str) -> Optional[User]:
        """Get user by Auth0 ID."""
        try:
            return User.objects.get(auth0_id=auth0_id)
        except User.DoesNotExist:
            return None

    @classmethod
    def get_by_email(cls, email: str) -> Optional[User]:
        """Get user by email."""
        try:
            return User.objects.get(email=email)
        except User.DoesNotExist:
            return None
