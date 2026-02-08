from datetime import datetime
from typing import Optional
from uuid import UUID

import os

from django.conf import settings
from ninja import Schema

from apps.users.models import User


def _build_picture_url(user: User) -> str:
    if not user.picture:
        return ""
    base = os.environ.get("DJANGO_BASE_URL", "http://localhost:8000")
    return f"{base}{settings.MEDIA_URL}{user.picture.name}"


class UserProfileResponse(Schema):
    id: UUID
    email: str
    first_name: str
    last_name: str
    display_name: str
    picture: str
    email_verified: bool
    has_password: bool
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
            created_at=user.created_at,
            last_login_at=user.last_login_at,
        )


class UserProfileUpdateRequest(Schema):
    first_name: Optional[str] = None
    last_name: Optional[str] = None


class SetPasswordRequest(Schema):
    new_password: str
    confirm_password: str
    current_password: Optional[str] = None


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


class CreateApiKeyRequest(Schema):
    name: str


class ApiKeyResponse(Schema):
    id: UUID
    name: str
    prefix: str
    last_used_at: Optional[datetime] = None
    created_at: datetime


class CreateApiKeyResponse(Schema):
    key: str
    id: UUID
    name: str
    prefix: str
    created_at: datetime


class MessageResponse(Schema):
    message: str
