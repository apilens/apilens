from django.http import HttpRequest
from ninja import Router, File
from ninja.files import UploadedFile

from apps.auth.services import TokenService
from apps.users.models import User
from apps.users.services import UserService
from core.auth.authentication import jwt_auth
from core.exceptions.base import NotFoundError, ValidationError

from .schemas import (
    UserProfileResponse,
    UserProfileUpdateRequest,
    SetPasswordRequest,
    UserContextResponse,
    PictureResponse,
    SessionResponse,
    MessageResponse,
    _build_picture_url,
)

router = Router(auth=[jwt_auth])


@router.get("/me", response=UserProfileResponse)
def get_current_user(request: HttpRequest):
    user: User = request.auth
    return UserProfileResponse.from_user(user)


@router.patch("/me", response=UserProfileResponse)
def update_current_user(request: HttpRequest, data: UserProfileUpdateRequest):
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

    return UserProfileResponse.from_user(user)


@router.delete("/me", response=MessageResponse)
def delete_current_user(request: HttpRequest):
    user: User = request.auth
    TokenService.revoke_all_for_user(user)
    user.is_active = False
    user.save(update_fields=["is_active", "updated_at"])
    return {"message": "Account deactivated"}


@router.get("/context", response=UserContextResponse)
def get_user_context(request: HttpRequest):
    user: User = request.auth
    context = getattr(request, "tenant_context", None)

    return UserContextResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        picture=_build_picture_url(user),
        is_authenticated=True,
        permissions=context.permissions if context else [],
        role=context.role if context else "member",
    )


@router.post("/me/picture", response=PictureResponse)
def upload_picture(request: HttpRequest, file: UploadedFile = File(...)):
    user: User = request.auth
    user = UserService.update_picture(user, file)
    return PictureResponse(
        picture=_build_picture_url(user),
        message="Profile picture updated",
    )


@router.delete("/me/picture", response=MessageResponse)
def remove_picture(request: HttpRequest):
    user: User = request.auth
    UserService.remove_picture(user)
    return {"message": "Profile picture removed"}


@router.post("/me/password", response=MessageResponse)
def set_password(request: HttpRequest, data: SetPasswordRequest):
    user: User = request.auth
    if data.new_password != data.confirm_password:
        raise ValidationError("Passwords do not match")
    auth_method = getattr(request, "token_claims", {}).get("am")
    UserService.set_password(user, data.new_password, data.current_password, auth_method=auth_method)
    return {"message": "Password updated successfully"}


@router.post("/logout-all", response=MessageResponse)
def logout_all(request: HttpRequest):
    user: User = request.auth
    count = TokenService.revoke_all_for_user(user)
    return {"message": f"Revoked {count} sessions"}


@router.get("/sessions", response=list[SessionResponse])
def list_sessions(request: HttpRequest):
    user: User = request.auth

    # Get token_family from the access token claims (set by JWTBearer auth)
    current_family = getattr(request, "_token_family", None)

    sessions = TokenService.get_active_sessions(user)
    return [
        SessionResponse(
            id=s.id,
            device_info=s.device_info,
            ip_address=s.ip_address,
            location=s.location,
            last_used_at=s.last_used_at,
            created_at=s.created_at,
            is_current=str(s.token_family) == current_family if current_family else False,
        )
        for s in sessions
    ]


@router.delete("/sessions/{session_id}", response=MessageResponse)
def revoke_session(request: HttpRequest, session_id: str):
    user: User = request.auth
    revoked = TokenService.revoke_session(user, session_id)
    if not revoked:
        raise NotFoundError("Session not found")
    return {"message": "Session revoked"}
