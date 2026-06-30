from typing import Optional
from uuid import UUID
from datetime import datetime

from ninja import Schema


class MagicLinkRequest(Schema):
    email: str


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


class PasswordLoginResponse(Schema):
    # When 2FA is required: only twofa_required + challenge_token are set.
    # Otherwise: access_token, refresh_token, etc. are set.
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    token_type: str = "Bearer"
    expires_in: int = 900
    twofa_required: bool = False
    challenge_token: Optional[str] = None


class TwoFactorExchangeRequest(Schema):
    challenge_token: str
    code: str
    remember_me: bool = True
    use_backup_code: bool = False


# Account recovery for users locked out of 2FA
class RecoveryRequestBody(Schema):
    email: str


class RecoveryTokenBody(Schema):
    token: str


class RecoveryStatusResponse(Schema):
    status: str  # "pending" | "confirmed" | "cancelled" | "expired" | "invalid"
    email: Optional[str] = None
    requested_at: Optional[str] = None
    available_at: Optional[str] = None
    expires_at: Optional[str] = None
    is_ready: bool = False


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


class IdentifyRequest(Schema):
    email: str


class IdentifyResponse(Schema):
    # The recommended primary path for this user.
    method: str  # "passkey" | "password" | "magic_link_sent" | "no_account"
    passkey_options: Optional[dict] = None   # set when method == "passkey"
    twofa_required: bool = False              # set when method == "password"
    # Other methods the user has available. The UI surfaces these as
    # "or use X instead" links so a passkey user can still fall back to
    # password (or vice versa) without leaving the sign-in screen.
    fallbacks: list[str] = []  # subset of {"passkey", "password", "magic_link"}


class PasskeyDeleteRequest(Schema):
    credential_id: str


# Two-Factor Authentication schemas
class TwoFactorEnableResponse(Schema):
    secret: str
    qr_code_uri: str


class TwoFactorVerifyRequest(Schema):
    code: str
    password: Optional[str] = None


class TwoFactorDisableRequest(Schema):
    # User must supply exactly one of these to prove identity:
    #   password    — current password (if user has one)
    #   code        — current 6-digit TOTP from authenticator
    #   backup_code — single-use backup code (for users who lost the authenticator)
    password: Optional[str] = None
    code: Optional[str] = None
    backup_code: Optional[str] = None


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


class InviteInfoRequest(Schema):
    token: str


class InviteInfoResponse(Schema):
    valid: bool
    email: str = ""
    role: str = ""
    project_name: str = ""
    project_slug: str = ""
    inviter: str = ""
