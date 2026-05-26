import os
from datetime import datetime
from typing import Optional
from uuid import UUID

from django.conf import settings
from ninja import Schema

from apps.users.models import User
from apps.users.services import UserService


def _build_picture_url(user: User) -> str:
    """Return the public URL for the user's picture, or "".

    On GCS (prod) `picture.url` is already absolute (`https://storage.googleapis.com/<bucket>/...`).
    On the local filesystem backend it's path-relative (`/media/...`), so we prepend
    DJANGO_BASE_URL — settable to e.g. `http://localhost:8000` for local dev.
    """
    if not user.picture:
        return ""
    url = user.picture.url
    if url.startswith(("http://", "https://")):
        base_url = url
    else:
        base = os.environ.get("DJANGO_BASE_URL", "http://localhost:8000").rstrip("/")
        base_url = f"{base}{url}"
    cache_bust = int(user.updated_at.timestamp()) if user.updated_at else ""
    return f"{base_url}?v={cache_bust}" if cache_bust else base_url


class UserProfileResponse(Schema):
    id: UUID
    email: str
    first_name: str
    last_name: str
    display_name: str
    picture: str
    email_verified: bool
    has_password: bool
    timezone: str
    created_at: datetime
    last_login_at: Optional[datetime] = None

    @staticmethod
    def from_user(user: User) -> "UserProfileResponse":
        return UserProfileResponse(
            id=user.id,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            display_name=user.display_name,
            picture=_build_picture_url(user),
            email_verified=user.email_verified,
            has_password=user.has_usable_password(),
            timezone=UserService.get_timezone(user),
            created_at=user.created_at,
            last_login_at=user.last_login_at,
        )


class UserProfileUpdateRequest(Schema):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    timezone: Optional[str] = None


class SetPasswordRequest(Schema):
    new_password: str
    confirm_password: str
    current_password: Optional[str] = None


class SetPasswordResponse(Schema):
    message: str
    access_token: str
    refresh_token: str


class PictureResponse(Schema):
    picture: str
    message: str


class UserContextResponse(Schema):
    id: UUID
    email: str
    display_name: str
    picture: str
    is_authenticated: bool = True
    permissions: list[str] = []
    role: str = "member"


class SessionResponse(Schema):
    id: UUID
    device_info: str
    ip_address: Optional[str] = None
    location: str = ""
    last_used_at: datetime
    created_at: datetime
    is_current: bool = False


class MessageResponse(Schema):
    message: str
