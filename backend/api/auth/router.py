from django.http import HttpRequest
from ninja import Router

from apps.auth.services import AuthService, TokenService, PasswordResetService, PasskeyService
from core.auth.authentication import JWTBearer

from .schemas import (
    MagicLinkRequest,
    PasswordLoginRequest,
    VerifyRequest,
    RefreshRequest,
    LogoutRequest,
    ValidateRequest,
    ValidateResponse,
    TokenResponse,
    MessageResponse,
    PasswordResetRequest,
    PasswordResetVerifyRequest,
    PasswordResetResetRequest,
    PasskeyRegistrationOptionsRequest,
    PasskeyRegistrationVerifyRequest,
    PasskeyAuthenticationOptionsRequest,
    PasskeyAuthenticationVerifyRequest,
    PasskeyCredentialResponse,
    PasskeyDeleteRequest,
    CheckUserRequest,
    CheckUserResponse,
    TwoFactorEnableResponse,
    TwoFactorVerifyRequest,
    TwoFactorStatusResponse,
    BackupCodesResponse,
    TwoFactorLoginVerifyRequest,
)

router = Router()


def _get_client_ip(request: HttpRequest) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


@router.post("/magic-link", response={200: MessageResponse})
def request_magic_link(request: HttpRequest, data: MagicLinkRequest):
    ip = _get_client_ip(request)
    AuthService.request_magic_link(data.email, ip_address=ip, flow=data.flow)
    return {"message": "If that email is valid, a magic link has been sent."}


@router.post("/check-user", response={200: CheckUserResponse})
def check_user(request: HttpRequest, data: CheckUserRequest):
    """Check if user exists and has password/passkey/2FA configured."""
    from apps.users.models import User
    from apps.auth.models import PasskeyCredential, TOTPDevice

    email = data.email.lower().strip()
    if not email:
        return CheckUserResponse(exists=False, has_password=False, has_passkey=False, has_2fa=False)

    try:
        user = User.objects.get(email=email, is_active=True)
        has_password = bool(user.password)
        has_passkey = PasskeyCredential.objects.filter(user=user).exists()
        has_2fa = TOTPDevice.objects.filter(user=user, is_verified=True).exists()

        return CheckUserResponse(
            exists=True,
            has_password=has_password,
            has_passkey=has_passkey,
            has_2fa=has_2fa,
        )
    except User.DoesNotExist:
        # Don't reveal if user exists for security
        return CheckUserResponse(exists=False, has_password=False, has_passkey=False, has_2fa=False)


@router.post("/login", response={200: TokenResponse})
def login_with_password(request: HttpRequest, data: PasswordLoginRequest):
    ip = _get_client_ip(request)
    device = request.META.get("HTTP_USER_AGENT", "")[:255]
    access_token, refresh_token, _ = AuthService.login_with_password(
        data.email, data.password, device_info=device,
        ip_address=ip, remember_me=data.remember_me,
    )
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/verify", response={200: TokenResponse})
def verify_magic_link(request: HttpRequest, data: VerifyRequest):
    ip = _get_client_ip(request)
    device = data.device_info or request.META.get("HTTP_USER_AGENT", "")[:255]
    access_token, refresh_token, _ = AuthService.verify_magic_link(
        data.token, device_info=device, ip_address=ip, remember_me=data.remember_me,
    )
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/refresh", response={200: TokenResponse})
def refresh_token(request: HttpRequest, data: RefreshRequest):
    access_token, refresh_token, _ = AuthService.refresh_session(data.refresh_token)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/validate", response={200: ValidateResponse})
def validate_session(request: HttpRequest, data: ValidateRequest):
    valid = TokenService.is_session_alive(data.refresh_token)
    return ValidateResponse(valid=valid)


@router.post("/logout", response={200: MessageResponse})
def logout(request: HttpRequest, data: LogoutRequest):
    AuthService.logout(data.refresh_token)
    return {"message": "Logged out successfully"}


@router.post("/password-reset/request", response={200: MessageResponse})
def request_password_reset(request: HttpRequest, data: PasswordResetRequest):
    ip = _get_client_ip(request)
    PasswordResetService.create_and_send(data.email, ip_address=ip)
    return {"message": "If that email is associated with an account, a password reset link has been sent."}


@router.post("/password-reset/verify", response={200: MessageResponse})
def verify_password_reset_token(request: HttpRequest, data: PasswordResetVerifyRequest):
    email = PasswordResetService.verify_token(data.token)
    return {"message": f"Token is valid for {email}"}


@router.post("/password-reset/reset", response={200: MessageResponse})
def reset_password(request: HttpRequest, data: PasswordResetResetRequest):
    PasswordResetService.reset_password(data.token, data.new_password)
    return {"message": "Password has been reset successfully"}


# Passkey endpoints
@router.post("/passkey/register/options", response={200: dict}, auth=JWTBearer())
def passkey_register_options(request: HttpRequest, data: PasskeyRegistrationOptionsRequest):
    options = PasskeyService.generate_registration_options(request.auth)
    return options


@router.post("/passkey/register/verify", response={200: MessageResponse}, auth=JWTBearer())
def passkey_register_verify(request: HttpRequest, data: PasskeyRegistrationVerifyRequest):
    PasskeyService.verify_and_save_credential(
        request.auth, data.credential, data.challenge, data.device_name
    )
    return {"message": "Passkey registered successfully"}


@router.post("/passkey/login/options", response={200: dict})
def passkey_login_options(request: HttpRequest, data: PasskeyAuthenticationOptionsRequest):
    options = PasskeyService.generate_authentication_options(data.email)
    return options


@router.post("/passkey/login/verify", response={200: TokenResponse})
def passkey_login_verify(request: HttpRequest, data: PasskeyAuthenticationVerifyRequest):
    ip = _get_client_ip(request)
    device = request.META.get("HTTP_USER_AGENT", "")[:255]

    user, passkey = PasskeyService.verify_and_authenticate(data.credential, data.challenge)

    refresh_token, token_family = TokenService.create_refresh_token(
        user, device_info=device, ip_address=ip, remember_me=True
    )
    access_token = TokenService.create_access_token(
        user, token_family=token_family, auth_method="passkey"
    )

    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.get("/passkey/credentials", response={200: list[PasskeyCredentialResponse]}, auth=JWTBearer())
def list_passkey_credentials(request: HttpRequest):
    credentials = PasskeyService.list_credentials(request.auth)
    return [
        PasskeyCredentialResponse(
            id=cred.id,
            device_name=cred.device_name,
            last_used_at=cred.last_used_at,
            created_at=cred.created_at,
        )
        for cred in credentials
    ]


@router.delete("/passkey/credentials/{credential_id}", response={200: MessageResponse}, auth=JWTBearer())
def delete_passkey_credential(request: HttpRequest, credential_id: str):
    success = PasskeyService.delete_credential(request.auth, credential_id)
    if not success:
        return {"message": "Passkey not found"}, 404
    return {"message": "Passkey deleted successfully"}


# Two-Factor Authentication endpoints
@router.get("/2fa/status", response={200: TwoFactorStatusResponse}, auth=JWTBearer())
def get_2fa_status(request: HttpRequest):
    """Get current 2FA status for authenticated user."""
    from apps.auth.services import TwoFactorService
    
    enabled = TwoFactorService.has_2fa_enabled(request.auth)
    backup_codes_remaining = 0
    
    if enabled:
        backup_codes_remaining = TwoFactorService.get_remaining_backup_codes_count(request.auth)
    
    return TwoFactorStatusResponse(
        enabled=enabled,
        backup_codes_remaining=backup_codes_remaining
    )


@router.post("/2fa/enable", response={200: TwoFactorEnableResponse}, auth=JWTBearer())
def enable_2fa(request: HttpRequest):
    """Enable 2FA and get QR code for scanning."""
    from apps.auth.services import TwoFactorService
    
    secret, qr_code_uri = TwoFactorService.enable_2fa(request.auth)
    
    return TwoFactorEnableResponse(
        secret=secret,
        qr_code_uri=qr_code_uri
    )


@router.post("/2fa/verify", response={200: BackupCodesResponse}, auth=JWTBearer())
def verify_2fa_setup(request: HttpRequest, data: TwoFactorVerifyRequest):
    """Verify TOTP code and activate 2FA."""
    from apps.auth.services import TwoFactorService
    from core.exceptions.base import ValidationError
    
    success = TwoFactorService.verify_and_activate_2fa(request.auth, data.code)
    
    if not success:
        raise ValidationError("Invalid verification code. Please try again.")
    
    # Generate backup codes
    backup_codes = TwoFactorService.generate_backup_codes(request.auth)
    
    return BackupCodesResponse(codes=backup_codes)


@router.post("/2fa/disable", response={200: MessageResponse}, auth=JWTBearer())
def disable_2fa(request: HttpRequest):
    """Disable 2FA for authenticated user."""
    from apps.auth.services import TwoFactorService
    
    success = TwoFactorService.disable_2fa(request.auth)
    
    if not success:
        return {"message": "2FA is not enabled"}
    
    return {"message": "Two-factor authentication has been disabled"}


@router.post("/2fa/backup-codes/regenerate", response={200: BackupCodesResponse}, auth=JWTBearer())
def regenerate_backup_codes(request: HttpRequest):
    """Regenerate backup codes."""
    from apps.auth.services import TwoFactorService
    from core.exceptions.base import ValidationError
    
    if not TwoFactorService.has_2fa_enabled(request.auth):
        raise ValidationError("2FA is not enabled")
    
    backup_codes = TwoFactorService.generate_backup_codes(request.auth)
    
    return BackupCodesResponse(codes=backup_codes)


@router.post("/2fa/verify-login", response={200: TokenResponse})
def verify_2fa_login(request: HttpRequest, data: TwoFactorLoginVerifyRequest):
    """Verify 2FA code during login."""
    from apps.auth.services import TwoFactorService, TokenService
    from apps.users.models import User
    from core.exceptions.base import AuthenticationError
    
    # First verify password
    try:
        user = User.objects.get(email=data.email.lower().strip(), is_active=True)
    except User.DoesNotExist:
        raise AuthenticationError("Invalid email or password")
    
    if not user.password or not user.check_password(data.password):
        raise AuthenticationError("Invalid email or password")
    
    # Then verify 2FA code or backup code
    if data.use_backup_code:
        valid = TwoFactorService.verify_backup_code(user, data.code)
    else:
        valid = TwoFactorService.verify_totp_code(user, data.code)
    
    if not valid:
        raise AuthenticationError("Invalid verification code")
    
    # Create tokens
    ip = _get_client_ip(request)
    device = request.META.get("HTTP_USER_AGENT", "")[:255]
    
    refresh_token, token_family = TokenService.create_refresh_token(
        user, device_info=device, ip_address=ip, remember_me=data.remember_me
    )
    access_token = TokenService.create_access_token(
        user, token_family=token_family, auth_method="password_2fa"
    )
    
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)
