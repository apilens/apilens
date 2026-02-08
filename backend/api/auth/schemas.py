from typing import Optional
from uuid import UUID
from datetime import datetime

from ninja import Schema


class MagicLinkRequest(Schema):
    email: str
    flow: Optional[str] = None


class PasswordLoginRequest(Schema):
    email: str
    password: str
    remember_me: bool = True


class VerifyRequest(Schema):
    token: str
    device_info: str = ""
    remember_me: bool = True


class RefreshRequest(Schema):
    refresh_token: str


class LogoutRequest(Schema):
    refresh_token: str


class TokenResponse(Schema):
    access_token: str
    refresh_token: str
    token_type: str = "Bearer"
    expires_in: int = 900  # 15 minutes


class ValidateRequest(Schema):
    refresh_token: str


class ValidateResponse(Schema):
    valid: bool


class MessageResponse(Schema):
    message: str


class SessionResponse(Schema):
    id: UUID
    device_info: str
    ip_address: Optional[str] = None
    last_used_at: datetime
    created_at: datetime
