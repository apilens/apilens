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


class PasswordResetRequest(Schema):
    email: str


class PasswordResetVerifyRequest(Schema):
    token: str


class PasswordResetResetRequest(Schema):
    token: str
    new_password: str


class PasskeyRegistrationOptionsRequest(Schema):
    pass  # No fields needed, user is from auth


class PasskeyRegistrationVerifyRequest(Schema):
    credential: dict
    challenge: str
    device_name: Optional[str] = "Unnamed Device"


class PasskeyAuthenticationOptionsRequest(Schema):
    email: Optional[str] = None


class PasskeyAuthenticationVerifyRequest(Schema):
    credential: dict
    challenge: str


class PasskeyCredentialResponse(Schema):
    id: UUID
    device_name: str
    last_used_at: Optional[datetime] = None
    created_at: datetime


class CheckUserRequest(Schema):
    email: str


class CheckUserResponse(Schema):
    exists: bool
    has_password: bool
    has_passkey: bool
    has_2fa: bool = False


class PasskeyDeleteRequest(Schema):
    credential_id: str


# Two-Factor Authentication schemas
class TwoFactorEnableResponse(Schema):
    secret: str
    qr_code_uri: str


class TwoFactorVerifyRequest(Schema):
    code: str


class TwoFactorStatusResponse(Schema):
    enabled: bool
    backup_codes_remaining: int = 0


class BackupCodesResponse(Schema):
    codes: list[str]


class TwoFactorLoginVerifyRequest(Schema):
    email: str
    password: str
    code: str
    remember_me: bool = True
    use_backup_code: bool = False
