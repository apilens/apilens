"""
Users API router.

Provides endpoints for user profile management and context.
All endpoints require Auth0 JWT authentication.
"""

from django.http import HttpRequest
from ninja import Router

from apps.users.models import User
from apps.users.services import UserSyncService
from core.auth.authentication import auth0_auth, auth0_auth_optional
from .schemas import (
    UserProfileResponse,
    UserProfileUpdateRequest,
    UserContextResponse,
)

router = Router(auth=auth0_auth)


@router.get("/me", response=UserProfileResponse)
def get_current_user(request: HttpRequest):
    """
    Get the current authenticated user's profile.

    Returns the user profile data stored in Django, synced from Auth0.
    """
    user: User = request.auth
    return UserProfileResponse(
        id=user.id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        display_name=user.display_name,
        picture=user.picture,
        email_verified=user.email_verified,
        provider=user.provider,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
    )


@router.patch("/me", response=UserProfileResponse)
def update_current_user(request: HttpRequest, data: UserProfileUpdateRequest):
    """
    Update the current user's profile.

    Only allows updating fields that are not managed by Auth0
    (currently first_name and last_name).
    """
    user: User = request.auth
    update_fields = []

    if data.first_name is not None:
        user.first_name = data.first_name[:150]
        update_fields.append("first_name")

    if data.last_name is not None:
        user.last_name = data.last_name[:150]
        update_fields.append("last_name")

    if update_fields:
        user.save(update_fields=update_fields + ["updated_at"])

    return UserProfileResponse(
        id=user.id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        display_name=user.display_name,
        picture=user.picture,
        email_verified=user.email_verified,
        provider=user.provider,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
    )


@router.get("/context", response=UserContextResponse)
def get_user_context(request: HttpRequest):
    """
    Get user context for frontend applications.

    Returns minimal user info plus permissions and role.
    Useful for initializing frontend state.
    """
    user: User = request.auth
    context = getattr(request, "tenant_context", None)

    return UserContextResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        picture=user.picture,
        is_authenticated=True,
        permissions=context.permissions if context else [],
        role=context.role if context else "member",
    )


@router.post("/sync")
def sync_user(request: HttpRequest):
    """
    Force sync user data from Auth0.

    Useful when user updates their profile in Auth0 and wants
    to immediately reflect changes in Django.
    """
    user: User = request.auth
    claims = getattr(request, "token_claims", {})

    if claims:
        user = UserSyncService.get_or_create_from_token(claims)
        UserSyncService.update_last_login(user)

    return {
        "message": "User synced successfully",
        "user_id": str(user.id),
        "email": user.email,
    }
