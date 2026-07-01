from datetime import datetime
from typing import Optional
from uuid import UUID

from ninja import Schema

from apps.users.models import User
from apps.users.services import UserService


class UserProfileResponse(Schema):
    id: UUID
    email: str
    first_name: str
    last_name: str
    display_name: str
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


class UserContextResponse(Schema):
    id: UUID
    email: str
    display_name: str
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
