from django.http import HttpRequest
from ninja import Router

from apps.auth.services import AuthService, TokenService, PasswordResetService, PasskeyService
from apps.auth.authentication import JWTBearer

from .schemas import (
    MagicLinkRequest,
    PasswordLoginRequest,
    PasswordLoginResponse,
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
    IdentifyRequest,
    IdentifyResponse,
    TwoFactorEnableResponse,
    TwoFactorVerifyRequest,
    TwoFactorDisableRequest,
    TwoFactorStatusResponse,
    BackupCodesResponse,
    TwoFactorExchangeRequest,
    RecoveryRequestBody,
    RecoveryTokenBody,
    RecoveryStatusResponse,
    InviteInfoRequest,
    InviteInfoResponse,
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
    AuthService.request_magic_link(data.email, ip_address=ip)
    return {"message": "If that email is valid, a magic link has been sent."}


@router.post("/invite-info", response={200: InviteInfoResponse})
def invite_info(request: HttpRequest, data: InviteInfoRequest):
    """Public: resolve a project invitation token for the accept landing page."""
    from apps.projects.membership import MembershipService

    return MembershipService.get_invitation_info(data.token)


@router.post("/identify", response={200: IdentifyResponse})
def identify(request: HttpRequest, data: IdentifyRequest):
    """Decide the best auth method for this email.

    Returns one of:
      { method: "passkey", passkey_options: {...} }   user has a passkey
      { method: "password", twofa_required: bool }    user has a usable password
      { method: "magic_link_sent" }                   magic-link-only user (link sent)
      { method: "no_account" }                        no account exists for this email

    Preference order: passkey > password > magic-link (per "passkey wins" UX decision).
    The "no_account" branch does NOT send anything — the caller decides whether
    to surface a signup CTA (login page) or proceed with signup (signup page).
    Rate-limited per IP (10/min) to prevent enumeration sweeps.
    """
    from django.core.cache import cache
    from apps.users.models import User
    from apps.auth.models import PasskeyCredential, TOTPDevice
    from apps.auth.services import PasskeyService, MagicLinkService
    from core.exceptions.base import RateLimitError

    # Per-IP rate-limit bucket
    ip = _get_client_ip(request) or "unknown"
    cache_key = f"check_user_ip:{ip}"
    count = cache.get(cache_key, 0)
    if count >= 10:
        raise RateLimitError("Too many lookups. Please wait a minute.")
    cache.set(cache_key, count + 1, 60)

    email = data.email.lower().strip()

    try:
        user = User.objects.get(email=email, is_active=True)
    except User.DoesNotExist:
        return IdentifyResponse(method="no_account")

    has_passkey = PasskeyCredential.objects.filter(user=user).exists()
    has_password = user.has_usable_password()

    # 1. Passkey wins as the recommended method, but password (if set) is a
    #    fallback so the user isn't stuck if they cancel the biometric prompt
    #    or are on a device without their passkey.
    if has_passkey:
        options = PasskeyService.generate_authentication_options(email)
        fallbacks = []
        if has_password:
            fallbacks.append("password")
        fallbacks.append("magic_link")
        return IdentifyResponse(
            method="passkey", passkey_options=options, fallbacks=fallbacks,
        )

    # 2. Password (with optional 2FA) — magic link is the only fallback
    if has_password:
        twofa = TOTPDevice.objects.filter(user=user, is_verified=True).exists()
        return IdentifyResponse(
            method="password", twofa_required=twofa, fallbacks=["magic_link"],
        )

    # 3. Magic-link-only existing user — send the link, no fallbacks
    MagicLinkService.create_and_send(email, ip_address=ip)
    return IdentifyResponse(method="magic_link_sent")


# /check-user removed — replaced by /auth/identify which performs both the
# auth-method lookup and the action (passkey-options issuance OR magic-link send)
# in a single rate-limited call.


@router.post("/login", response={200: PasswordLoginResponse})
def login_with_password(request: HttpRequest, data: PasswordLoginRequest):
    from core.auth.jwt import create_2fa_challenge_token

    ip = _get_client_ip(request)
    device = request.META.get("HTTP_USER_AGENT", "")[:255]
    access_token, refresh_token, user, twofa_required = AuthService.login_with_password(
        data.email, data.password, device_info=device,
        ip_address=ip, remember_me=data.remember_me,
    )

    if twofa_required:
        challenge = create_2fa_challenge_token(user)
        return PasswordLoginResponse(twofa_required=True, challenge_token=challenge)

    return PasswordLoginResponse(
        access_token=access_token,
        refresh_token=refresh_token,
    )


@router.post("/2fa/exchange", response={200: TokenResponse})
def exchange_2fa_challenge(request: HttpRequest, data: TwoFactorExchangeRequest):
    """Exchange a 2fa_pending challenge token + code for real tokens."""
    from django.core.cache import cache
    from core.auth.jwt import verify_2fa_challenge_token
    from apps.auth.services import (
        AuthService, TwoFactorService,
        PASSWORD_LOGIN_RATE_LIMIT, PASSWORD_LOGIN_LOCKOUT_WINDOW,
    )
    from apps.users.models import User
    from core.exceptions.base import AuthenticationError, RateLimitError

    # Validate the challenge token (signature + expiry + type)
    claims = verify_2fa_challenge_token(data.challenge_token)
    email = claims["email"]

    # Same per-email throttle as the password-login endpoint
    cache_key = f"login_attempts:{email}"
    attempts = cache.get(cache_key, 0)
    if attempts >= PASSWORD_LOGIN_RATE_LIMIT:
        raise RateLimitError("Too many login attempts. Please wait 15 minutes before trying again.")

    try:
        user = User.objects.get(id=claims["sub"], is_active=True)
    except User.DoesNotExist:
        raise AuthenticationError("Account no longer available")

    ip = _get_client_ip(request)
    device = request.META.get("HTTP_USER_AGENT", "")[:255]

    if data.use_backup_code:
        valid = TwoFactorService.verify_backup_code(
            user, data.code, ip_address=ip, device_info=device,
        )
    else:
        valid = TwoFactorService.verify_totp_code(user, data.code)

    if not valid:
        cache.set(cache_key, attempts + 1, PASSWORD_LOGIN_LOCKOUT_WINDOW)
        raise AuthenticationError("Invalid verification code")

    cache.delete(cache_key)

    access_token, refresh_token = AuthService.complete_2fa_login(
        user, device_info=device, ip_address=ip, remember_me=data.remember_me,
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
    ip = _get_client_ip(request)
    PasswordResetService.reset_password(data.token, data.new_password, ip_address=ip)
    return {"message": "Password has been reset successfully"}


# Account recovery (for users locked out of 2FA)
@router.post("/recovery/request", response={200: MessageResponse})
def recovery_request(request: HttpRequest, data: RecoveryRequestBody):
    """Kick off the 48-hour recovery cooldown for an account with 2FA enabled.

    Always returns a generic success message — never reveals whether the email
    has an account or whether that account has 2FA enabled (enumeration guard).
    """
    from apps.auth.services import RecoveryService

    ip = _get_client_ip(request)
    RecoveryService.request(data.email, ip_address=ip)
    return {
        "message": "If this email has an account with 2FA, we sent a recovery link. Check your inbox."
    }


@router.get("/recovery/status", response={200: RecoveryStatusResponse})
def recovery_status(request: HttpRequest, token: str):
    """Public status check by token. Used by the recovery page to render the
    countdown / confirm / cancelled / expired states."""
    from apps.auth.services import RecoveryService

    info = RecoveryService.get_status(token)
    return RecoveryStatusResponse(**info)


@router.post("/recovery/confirm", response={200: MessageResponse})
def recovery_confirm(request: HttpRequest, data: RecoveryTokenBody):
    """Disable 2FA + wipe backup codes + revoke sessions. Only succeeds once
    the cooldown has elapsed."""
    from apps.auth.services import RecoveryService

    ip = _get_client_ip(request)
    device = request.META.get("HTTP_USER_AGENT", "")[:255]
    RecoveryService.confirm(data.token, ip_address=ip, device_info=device)
    return {"message": "Two-factor authentication has been disabled. You can now sign in."}


@router.post("/recovery/cancel", response={200: MessageResponse})
def recovery_cancel(request: HttpRequest, data: RecoveryTokenBody):
    """Immediately invalidate a pending recovery request — the 'this wasn't me' button."""
    from apps.auth.services import RecoveryService

    RecoveryService.cancel(data.token)
    return {"message": "Recovery request cancelled."}


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
    """Verify TOTP code and activate 2FA. Requires password if the user has one."""
    from apps.auth.services import TwoFactorService
    from core.exceptions.base import AuthenticationError, ValidationError

    user = request.auth

    # Users with a usable password must confirm it before enabling 2FA.
    # Magic-link-only users skip (no password exists to verify).
    if user.has_usable_password():
        if not data.password:
            raise ValidationError("Current password is required to enable 2FA")
        if not user.check_password(data.password):
            raise AuthenticationError("Current password is incorrect")

    ip = _get_client_ip(request)
    device = request.META.get("HTTP_USER_AGENT", "")[:255]
    success = TwoFactorService.verify_and_activate_2fa(
        user, data.code, ip_address=ip, device_info=device,
    )

    if not success:
        raise ValidationError("Invalid verification code. Please try again.")

    # Generate backup codes
    backup_codes = TwoFactorService.generate_backup_codes(user)

    return BackupCodesResponse(codes=backup_codes)


@router.post("/2fa/disable", response={200: MessageResponse}, auth=JWTBearer())
def disable_2fa(request: HttpRequest, data: TwoFactorDisableRequest):
    """Disable 2FA for authenticated user.

    Accepts ONE of: current password, current TOTP code, or a backup code.
    Backup codes are the recovery path for users who've lost their authenticator
    AND don't have a usable password (magic-link-only accounts).
    """
    from apps.auth.services import TwoFactorService
    from core.exceptions.base import AuthenticationError, ValidationError

    user = request.auth
    ip = _get_client_ip(request)
    device = request.META.get("HTTP_USER_AGENT", "")[:255]

    if data.backup_code:
        # Backup codes are single-use and trigger their own security email.
        if not TwoFactorService.verify_backup_code(
            user, data.backup_code, ip_address=ip, device_info=device,
        ):
            raise AuthenticationError("Invalid backup code")
    elif data.password and user.has_usable_password():
        if not user.check_password(data.password):
            raise AuthenticationError("Current password is incorrect")
    elif data.code:
        if not TwoFactorService.verify_totp_code(user, data.code):
            raise AuthenticationError("Invalid verification code")
    else:
        raise ValidationError(
            "Password, verification code, or backup code is required to disable 2FA"
        )

    success = TwoFactorService.disable_2fa(user, ip_address=ip, device_info=device)

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


# /2fa/verify-login removed — replaced by /auth/login + /auth/2fa/exchange flow
# (challenge-token avoids resubmitting the password for the second factor).


# ── Service endpoints: JWKS + API-key introspection ──────────────────────────
# Served by the identity service (Caddy routes /api/v1/auth/* there).

from ninja import Schema


@router.get("/.well-known/jwks.json")
def jwks(request: HttpRequest):
    """Public RS256 verification keys (empty list when running on legacy HS256)."""
    from core.auth import keys
    return keys.jwks()


class IntrospectRequest(Schema):
    api_key: str


@router.post("/introspect")
def introspect(request: HttpRequest, data: IntrospectRequest):
    """Validate an API key → its project context. Used by the ingest service so
    it doesn't re-implement the key lookup. Guarded by an internal shared secret
    (the auth host is publicly routed)."""
    import hashlib
    import os
    from apps.auth.models import ApiKey
    from core.exceptions.base import AuthenticationError

    expected = os.environ.get("INTERNAL_INTROSPECT_SECRET", "")
    if not expected or request.headers.get("X-Internal-Secret", "") != expected:
        raise AuthenticationError("introspection requires a valid internal secret")

    key_hash = hashlib.sha256(data.api_key.encode()).hexdigest()
    api_key = (
        ApiKey.objects.active()
        .select_related("project", "project__owner")
        .filter(key_hash=key_hash, project__is_active=True, project__owner__is_active=True)
        .first()
    )
    if api_key is None:
        return {"active": False}
    return {
        "active": True,
        "project_id": str(api_key.project_id),
        "project_slug": api_key.project.slug,
        "owner_id": str(api_key.project.owner_id),
    }
