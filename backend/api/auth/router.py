from django.http import HttpRequest
from ninja import Router

from apps.auth.services import AuthService, TokenService

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
