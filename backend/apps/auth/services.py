import base64
import hashlib
import json
import logging
import secrets
from datetime import timedelta

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.db import transaction
from django.utils import timezone

from apps.users.models import User
from core.auth.jwt import create_access_token as _encode_jwt
from core.exceptions.base import (
    AuthenticationError,
    MagicLinkOnlyError,
    RateLimitError,
    TokenExpiredError,
    TokenInvalidError,
)

from core.utils.geoip import resolve_location
from .models import ApiKey, MagicLinkToken, RefreshToken, PasswordResetToken, PasskeyCredential, RecoveryRequest

from webauthn import (
    generate_registration_options,
    verify_registration_response,
    generate_authentication_options,
    verify_authentication_response,
    options_to_json,
)
from webauthn.helpers.structs import (
    PublicKeyCredentialDescriptor,
    AuthenticatorTransport,
    AuthenticatorAttachment,
    UserVerificationRequirement,
    AuthenticatorSelectionCriteria,
    ResidentKeyRequirement,
)
from webauthn.helpers.cose import COSEAlgorithmIdentifier

logger = logging.getLogger(__name__)

ACCESS_TOKEN_LIFETIME = timedelta(minutes=15)
REFRESH_TOKEN_LIFETIME = timedelta(days=30)
REFRESH_TOKEN_SESSION_LIFETIME = timedelta(hours=24)
MAGIC_LINK_LIFETIME = timedelta(minutes=15)
MAGIC_LINK_RATE_LIMIT = 3  # per minute per email
PASSWORD_RESET_LIFETIME = timedelta(hours=1)
PASSWORD_RESET_RATE_LIMIT = 3  # per minute per email
PASSWORD_LOGIN_RATE_LIMIT = 10  # max attempts per 15-minute window per email
PASSWORD_LOGIN_LOCKOUT_WINDOW = 60 * 15  # 15 minutes in seconds

# Account-recovery cooldown — time between requesting recovery and being able
# to actually disable 2FA. Long enough to give the legit account holder time
# to receive the email and cancel if they didn't initiate.
RECOVERY_COOLDOWN = timedelta(hours=48)
# Grace window after the cooldown during which the recovery link still works.
RECOVERY_GRACE = timedelta(days=7)
# One request per user per day to prevent recovery spam to the user's email.
RECOVERY_RATE_LIMIT_WINDOW = timedelta(days=1)


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()


class TokenService:
    @staticmethod
    def _normalized_device(device_info: str) -> str:
        return (device_info or "").strip()[:255]

    @staticmethod
    def _parse_user_agent(ua: str) -> dict[str, str]:
        """
        Parse User-Agent to extract browser and OS for better session identification.
        Returns a consistent identifier even if UA string has minor variations.
        """
        if not ua or len(ua) < 10:
            return {"browser": "", "os": "", "device_type": "desktop"}

        ua_lower = ua.lower()
        browser = ""
        os_name = ""
        device_type = "desktop"

        # Device type detection
        if any(x in ua_lower for x in ["iphone", "ipad", "android", "mobile"]):
            device_type = "mobile"

        # Browser detection (order matters - Edge contains Chrome, Chrome contains Safari)
        if "edg/" in ua_lower or "edge/" in ua_lower:
            browser = "edge"
        elif "chrome/" in ua_lower and "edg/" not in ua_lower:
            browser = "chrome"
        elif "firefox/" in ua_lower:
            browser = "firefox"
        elif "safari/" in ua_lower and "chrome/" not in ua_lower:
            browser = "safari"
        else:
            browser = "other"

        # OS detection (check mobile first to avoid false macOS detection on iOS)
        if "iphone" in ua_lower or "ipad" in ua_lower:
            os_name = "ios"
        elif "android" in ua_lower:
            os_name = "android"
        elif "mac os x" in ua_lower or "macintosh" in ua_lower:
            os_name = "macos"
        elif "windows" in ua_lower:
            os_name = "windows"
        elif "linux" in ua_lower:
            os_name = "linux"
        else:
            os_name = "other"

        return {
            "browser": browser,
            "os": os_name,
            "device_type": device_type,
        }

    @staticmethod
    def _get_session_fingerprint(device_info: str, ip_address: str | None = None) -> str:
        """
        Create a consistent fingerprint for session deduplication.
        Uses parsed browser+OS when available, falls back to IP for unknown devices.
        """
        parsed = TokenService._parse_user_agent(device_info)

        # If we have browser and OS info, use that (ignore IP - it can change)
        if parsed["browser"] and parsed["os"]:
            return f"{parsed['browser']}|{parsed['os']}|{parsed['device_type']}"

        # Fallback: use full device_info + IP if we couldn't parse
        normalized = TokenService._normalized_device(device_info)
        if normalized:
            # Use device string but still ignore IP to avoid duplicates from network changes
            return normalized

        # Last resort: IP only (for cases where User-Agent is completely missing)
        return f"unknown|{ip_address or 'no-ip'}"

    @staticmethod
    def create_access_token(
        user: User, token_family: str | None = None, auth_method: str | None = None,
    ) -> str:
        now = timezone.now()
        payload = {
            "sub": str(user.id),
            "email": user.email,
            "iat": now,
            "exp": now + ACCESS_TOKEN_LIFETIME,
            "type": "access",
        }
        if token_family:
            payload["tfm"] = str(token_family)
        if auth_method:
            payload["am"] = auth_method
        return _encode_jwt(payload)

    @staticmethod
    @transaction.atomic
    def create_refresh_token(
        user: User, device_info: str = "", ip_address: str | None = None,
        remember_me: bool = True,
    ) -> tuple[str, str]:
        raw_token = secrets.token_urlsafe(48)
        lifetime = REFRESH_TOKEN_LIFETIME if remember_me else REFRESH_TOKEN_SESSION_LIFETIME
        normalized_device = TokenService._normalized_device(device_info)

        # Revoke existing tokens from the same device fingerprint to avoid duplicate
        # sessions. Uses smart fingerprinting (browser+OS) to deduplicate properly.
        fingerprint = TokenService._get_session_fingerprint(device_info, ip_address)

        # Find all tokens with the same session fingerprint and revoke them
        existing_tokens = RefreshToken.objects.for_user(user)
        for token in existing_tokens:
            token_fingerprint = TokenService._get_session_fingerprint(
                token.device_info, token.ip_address
            )
            if token_fingerprint == fingerprint:
                token.is_revoked = True
                token.save(update_fields=["is_revoked"])

        location = resolve_location(ip_address)

        token_obj = RefreshToken.objects.create(
            user=user,
            token_hash=_hash_token(raw_token),
            expires_at=timezone.now() + lifetime,
            device_info=normalized_device,
            ip_address=ip_address,
            location=location,
        )
        return raw_token, str(token_obj.token_family)

    @staticmethod
    @transaction.atomic
    def rotate_refresh_token(raw_token: str) -> tuple[str, str, User]:
        token_hash = _hash_token(raw_token)

        try:
            token_obj = RefreshToken.objects.select_related("user").get(
                token_hash=token_hash
            )
        except RefreshToken.DoesNotExist:
            raise TokenInvalidError("Invalid refresh token")

        # Reuse detection: if token is already revoked, revoke the entire family
        if token_obj.is_revoked:
            RefreshToken.objects.filter(token_family=token_obj.token_family).update(
                is_revoked=True
            )
            logger.warning(
                f"Refresh token reuse detected for user {token_obj.user_id}, "
                f"family {token_obj.token_family}"
            )
            raise TokenInvalidError("Refresh token reuse detected")

        if token_obj.is_expired:
            raise TokenExpiredError("Refresh token has expired")

        # Revoke old token
        token_obj.is_revoked = True
        token_obj.save(update_fields=["is_revoked"])

        # Issue new tokens in the same family
        user = token_obj.user
        new_raw = secrets.token_urlsafe(48)
        remaining = token_obj.expires_at - timezone.now()

        RefreshToken.objects.create(
            user=user,
            token_hash=_hash_token(new_raw),
            token_family=token_obj.token_family,
            expires_at=timezone.now() + remaining,
            device_info=token_obj.device_info,
            ip_address=token_obj.ip_address,
            location=token_obj.location,
        )

        access_token = TokenService.create_access_token(user, token_family=str(token_obj.token_family))
        return access_token, new_raw, user

    @staticmethod
    def revoke_token(raw_token: str) -> None:
        token_hash = _hash_token(raw_token)
        RefreshToken.objects.filter(token_hash=token_hash).update(is_revoked=True)

    @staticmethod
    def revoke_all_for_user(user: User, except_family: str | None = None) -> int:
        qs = RefreshToken.objects.filter(user=user, is_revoked=False)
        if except_family:
            qs = qs.exclude(token_family=except_family)
        return qs.update(is_revoked=True)

    @staticmethod
    def revoke_session(user: User, session_id: str) -> bool:
        updated = RefreshToken.objects.filter(
            id=session_id, user=user, is_revoked=False
        ).update(is_revoked=True)
        return updated > 0

    @staticmethod
    def is_session_alive(raw_token: str) -> bool:
        """Check if a refresh token is still valid (not revoked/expired) without rotating."""
        token_hash = _hash_token(raw_token)
        return RefreshToken.objects.filter(
            token_hash=token_hash, is_revoked=False, expires_at__gt=timezone.now()
        ).exists()

    @staticmethod
    def get_active_sessions(user: User) -> list[RefreshToken]:
        """
        Get one session per unique device (browser+OS combination).
        Uses smart fingerprinting that ignores IP changes and browser version updates.
        Most recently used token wins for each fingerprint.
        """
        rows = (
            RefreshToken.objects.for_user(user)
            .order_by("-last_used_at")
        )
        seen_fingerprints: set[str] = set()
        result: list[RefreshToken] = []
        for row in rows:
            fingerprint = TokenService._get_session_fingerprint(row.device_info, row.ip_address)
            if fingerprint in seen_fingerprints:
                continue
            seen_fingerprints.add(fingerprint)
            result.append(row)
        return result

    @staticmethod
    def cleanup_expired() -> int:
        count, _ = RefreshToken.objects.cleanup_expired()
        ml_count, _ = MagicLinkToken.objects.cleanup_expired()
        pr_count, _ = PasswordResetToken.objects.cleanup_expired()
        return count + ml_count + pr_count


class MagicLinkService:
    @staticmethod
    @transaction.atomic
    def create_and_send(email: str, ip_address: str | None = None) -> None:
        email = email.lower().strip()

        # Rate limiting: max 3 per minute per email
        one_minute_ago = timezone.now() - timedelta(minutes=1)
        recent_count = MagicLinkToken.objects.filter(
            email=email, created_at__gte=one_minute_ago
        ).count()
        if recent_count >= MAGIC_LINK_RATE_LIMIT:
            raise RateLimitError("Too many magic link requests. Please wait a moment.")

        raw_token = secrets.token_urlsafe(48)

        MagicLinkToken.objects.create(
            email=email,
            token_hash=_hash_token(raw_token),
            expires_at=timezone.now() + MAGIC_LINK_LIFETIME,
            ip_address=ip_address,
        )

        frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
        verify_url = f"{frontend_url}/auth/verify?token={raw_token}"

        from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai")
        context = {"verify_url": verify_url}
        plain_text = render_to_string("auth/emails/magic_link.txt", context)
        html_content = render_to_string("auth/emails/magic_link.html", context)

        msg = EmailMultiAlternatives(
            subject="Sign in to API Lens",
            body=plain_text,
            from_email=from_email,
            to=[email],
        )
        msg.attach_alternative(html_content, "text/html")
        msg.send(fail_silently=False)

        logger.info(f"Magic link sent to {email}")

    @staticmethod
    @transaction.atomic
    def verify(raw_token: str) -> str:
        token_hash = _hash_token(raw_token)

        try:
            token_obj = MagicLinkToken.objects.get(token_hash=token_hash)
        except MagicLinkToken.DoesNotExist:
            raise TokenInvalidError("Invalid magic link")

        if token_obj.is_used:
            raise TokenInvalidError("Magic link has already been used")

        if token_obj.is_expired:
            raise TokenExpiredError("Magic link has expired")

        token_obj.is_used = True
        token_obj.save(update_fields=["is_used"])

        return token_obj.email


class PasswordResetService:
    @staticmethod
    @transaction.atomic
    def create_and_send(email: str, ip_address: str | None = None) -> None:
        email = email.lower().strip()

        # Check if user exists with a usable password
        try:
            user = User.objects.get(email=email, is_active=True)
        except User.DoesNotExist:
            # For security, don't reveal if email exists or not
            logger.info(f"Password reset requested for non-existent user: {email}")
            return

        if not user.has_usable_password():
            # User uses magic link only, can't reset password
            logger.info(f"Password reset requested for magic-link-only user: {email}")
            return

        # Rate limiting: max 3 per minute per email
        one_minute_ago = timezone.now() - timedelta(minutes=1)
        recent_count = PasswordResetToken.objects.filter(
            email=email, created_at__gte=one_minute_ago
        ).count()
        if recent_count >= PASSWORD_RESET_RATE_LIMIT:
            raise RateLimitError("Too many password reset requests. Please wait a moment.")

        raw_token = secrets.token_urlsafe(48)

        PasswordResetToken.objects.create(
            email=email,
            token_hash=_hash_token(raw_token),
            expires_at=timezone.now() + PASSWORD_RESET_LIFETIME,
            ip_address=ip_address,
        )

        frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
        reset_url = f"{frontend_url}/auth/reset-password?token={raw_token}"

        from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai")
        context = {"reset_url": reset_url, "email": email}
        plain_text = render_to_string("auth/emails/password_reset.txt", context)
        html_content = render_to_string("auth/emails/password_reset.html", context)

        msg = EmailMultiAlternatives(
            subject="Reset your API Lens password",
            body=plain_text,
            from_email=from_email,
            to=[email],
        )
        msg.attach_alternative(html_content, "text/html")
        msg.send(fail_silently=False)

        logger.info(f"Password reset link sent to {email}")

    @staticmethod
    def verify_token(raw_token: str) -> str:
        """Verify a password reset token is valid and return the email."""
        token_hash = _hash_token(raw_token)

        try:
            token_obj = PasswordResetToken.objects.get(token_hash=token_hash)
        except PasswordResetToken.DoesNotExist:
            raise TokenInvalidError("Invalid password reset link")

        if token_obj.is_used:
            raise TokenInvalidError("Password reset link has already been used")

        if token_obj.is_expired:
            raise TokenExpiredError("Password reset link has expired")

        return token_obj.email

    @staticmethod
    @transaction.atomic
    def reset_password(
        raw_token: str, new_password: str, invalidate_sessions: bool = True,
        ip_address: str | None = None,
    ) -> User:
        """Reset user password using a valid token."""
        from .email import SecurityEmailService

        token_hash = _hash_token(raw_token)

        try:
            token_obj = PasswordResetToken.objects.get(token_hash=token_hash)
        except PasswordResetToken.DoesNotExist:
            raise TokenInvalidError("Invalid password reset link")

        if token_obj.is_used:
            raise TokenInvalidError("Password reset link has already been used")

        if token_obj.is_expired:
            raise TokenExpiredError("Password reset link has expired")

        # Mark token as used
        token_obj.is_used = True
        token_obj.save(update_fields=["is_used"])

        # Get user and update password
        try:
            user = User.objects.get(email=token_obj.email, is_active=True)
        except User.DoesNotExist:
            raise AuthenticationError("User account not found")

        user.set_password(new_password)
        user.save(update_fields=["password", "updated_at"])

        # Optionally invalidate all existing sessions for security
        if invalidate_sessions:
            TokenService.revoke_all_for_user(user)
            logger.info(f"Revoked all sessions for user {user.email} after password reset")

        logger.info(f"Password reset successful for {user.email}")

        SecurityEmailService.send(
            user, "password_reset_success", ip_address=ip_address,
        )

        return user


class AuthService:
    @staticmethod
    def request_magic_link(email: str, ip_address: str | None = None) -> None:
        MagicLinkService.create_and_send(email, ip_address)

    @staticmethod
    @transaction.atomic
    def verify_magic_link(
        raw_token: str, device_info: str = "", ip_address: str | None = None,
        remember_me: bool = True,
    ) -> tuple[str, str, User]:
        email = MagicLinkService.verify(raw_token)

        user, created = User.objects.get_or_create(
            email=email,
            defaults={
                "email_verified": True,
                "auth_provider": "magic_link",
                "is_active": True,
            },
        )

        if not user.email_verified:
            user.email_verified = True
            user.save(update_fields=["email_verified", "updated_at"])

        if created:
            user.set_unusable_password()
            user.save(update_fields=["password"])
            logger.info(f"New user created via magic link: {email}")

        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

        refresh_token, token_family = TokenService.create_refresh_token(
            user, device_info, ip_address, remember_me
        )
        access_token = TokenService.create_access_token(
            user, token_family=token_family, auth_method="magic_link",
        )

        return access_token, refresh_token, user

    @staticmethod
    @transaction.atomic
    def login_with_password(
        email: str, password: str, device_info: str = "",
        ip_address: str | None = None, remember_me: bool = True,
    ) -> tuple[str | None, str | None, User, bool]:
        """Verify password and either issue tokens or signal 2FA required.

        Returns (access_token, refresh_token, user, twofa_required). When
        twofa_required is True the tokens are None — caller must complete the
        second factor via /auth/2fa/exchange to receive tokens.
        """
        from django.core.cache import cache
        from .models import TOTPDevice

        email = email.lower().strip()
        cache_key = f"login_attempts:{email}"
        attempts = cache.get(cache_key, 0)
        if attempts >= PASSWORD_LOGIN_RATE_LIMIT:
            raise RateLimitError("Too many login attempts. Please wait 15 minutes before trying again.")

        try:
            user = User.objects.get(email=email, is_active=True)
        except User.DoesNotExist:
            cache.set(cache_key, attempts + 1, PASSWORD_LOGIN_LOCKOUT_WINDOW)
            raise AuthenticationError("Invalid email or password")

        if not user.has_usable_password():
            cache.set(cache_key, attempts + 1, PASSWORD_LOGIN_LOCKOUT_WINDOW)
            raise MagicLinkOnlyError(
                "This account uses sign-in links. Use 'Email Link' instead."
            )

        if not user.check_password(password):
            cache.set(cache_key, attempts + 1, PASSWORD_LOGIN_LOCKOUT_WINDOW)
            raise AuthenticationError("Invalid email or password")

        # Successful password verify — clear the failed-attempt counter
        cache.delete(cache_key)

        # If 2FA is on, do not issue tokens yet — return signal so the caller
        # can hand back a short-lived challenge token instead.
        has_2fa = TOTPDevice.objects.filter(user=user, is_verified=True).exists()
        if has_2fa:
            return None, None, user, True

        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

        refresh_token, token_family = TokenService.create_refresh_token(
            user, device_info, ip_address, remember_me,
        )
        access_token = TokenService.create_access_token(
            user, token_family=token_family, auth_method="password",
        )

        return access_token, refresh_token, user, False

    @staticmethod
    @transaction.atomic
    def complete_2fa_login(
        user: User, device_info: str = "",
        ip_address: str | None = None, remember_me: bool = True,
    ) -> tuple[str, str]:
        """Issue tokens after a successful 2FA challenge."""
        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at", "updated_at"])

        refresh_token, token_family = TokenService.create_refresh_token(
            user, device_info, ip_address, remember_me,
        )
        access_token = TokenService.create_access_token(
            user, token_family=token_family, auth_method="password_2fa",
        )
        return access_token, refresh_token

    @staticmethod
    def refresh_session(raw_refresh_token: str) -> tuple[str, str, User]:
        return TokenService.rotate_refresh_token(raw_refresh_token)

    @staticmethod
    def logout(raw_refresh_token: str) -> None:
        TokenService.revoke_token(raw_refresh_token)

    @staticmethod
    def logout_all(user: User) -> int:
        return TokenService.revoke_all_for_user(user)


API_KEY_PREFIX = "apilens_"
MAX_API_KEYS_PER_PROJECT = 10


class ApiKeyService:
    @staticmethod
    def create_key(project, name: str) -> tuple[str, ApiKey]:
        """Create a new API key for a project."""
        active_count = ApiKey.objects.for_project(project).count()
        if active_count >= MAX_API_KEYS_PER_PROJECT:
            raise RateLimitError(
                f"Maximum of {MAX_API_KEYS_PER_PROJECT} active API keys allowed per project"
            )

        raw_secret = secrets.token_urlsafe(40)
        raw_key = f"{API_KEY_PREFIX}{raw_secret}"
        prefix = raw_key[:16]

        api_key = ApiKey.objects.create(
            project=project,
            key_hash=_hash_token(raw_key),
            prefix=prefix,
            name=name[:100],
        )
        return raw_key, api_key

    @staticmethod
    def list_keys(project) -> list[ApiKey]:
        """List all active API keys for a project."""
        return list(ApiKey.objects.for_project(project).order_by("-created_at"))

    @staticmethod
    def revoke_key(project, key_id: str) -> bool:
        """Revoke a specific API key within a project."""
        updated = ApiKey.objects.filter(
            id=key_id, project=project, is_revoked=False
        ).update(is_revoked=True)
        return updated > 0

    @staticmethod
    def revoke_all_for_project(project) -> int:
        """Revoke all active API keys for a project."""
        return ApiKey.objects.filter(
            project=project, is_revoked=False
        ).update(is_revoked=True)


class PasskeyService:
    """Service for WebAuthn/Passkey authentication."""

    RP_ID = getattr(settings, "WEBAUTHN_RP_ID", "localhost")
    RP_NAME = getattr(settings, "WEBAUTHN_RP_NAME", "API Lens")
    RP_ORIGIN = getattr(settings, "FRONTEND_URL", "http://localhost:3000")

    @staticmethod
    def generate_registration_options(user: User) -> dict:
        """Generate WebAuthn registration options for a user."""
        # Get existing credentials to exclude them
        existing_creds = PasskeyCredential.objects.for_user(user)
        exclude_credentials = [
            PublicKeyCredentialDescriptor(
                id=base64.urlsafe_b64decode(cred.credential_id + "==")
            )
            for cred in existing_creds
        ]

        options = generate_registration_options(
            rp_id=PasskeyService.RP_ID,
            rp_name=PasskeyService.RP_NAME,
            user_id=str(user.id).encode(),
            user_name=user.email,
            user_display_name=user.email.split("@")[0],
            exclude_credentials=exclude_credentials,
            authenticator_selection=AuthenticatorSelectionCriteria(
                # Bind the new passkey to the device's built-in biometric (Touch ID,
                # Face ID, Windows Hello). Without this, browsers — especially mobile
                # Safari — default to "use a passkey from another device" via QR,
                # which is jarring when the user is on the device they want to enroll.
                authenticator_attachment=AuthenticatorAttachment.PLATFORM,
                resident_key=ResidentKeyRequirement.PREFERRED,
                user_verification=UserVerificationRequirement.PREFERRED,
            ),
            supported_pub_key_algs=[
                COSEAlgorithmIdentifier.ECDSA_SHA_256,
                COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256,
            ],
        )

        # Store challenge in user session or cache (for verification)
        # For simplicity, we'll return it and expect the frontend to send it back
        return {"publicKey": json.loads(options_to_json(options))}

    @staticmethod
    @transaction.atomic
    def verify_and_save_credential(
        user: User,
        credential_data: dict,
        challenge: str,
        device_name: str = "",
    ) -> PasskeyCredential:
        """Verify registration response and save the credential."""
        try:
            # Decode the base64url challenge back to bytes
            challenge_bytes = base64.urlsafe_b64decode(challenge + "==")

            verification = verify_registration_response(
                credential=credential_data,
                expected_challenge=challenge_bytes,
                expected_rp_id=PasskeyService.RP_ID,
                expected_origin=PasskeyService.RP_ORIGIN,
            )

            # Save the credential
            credential_id_b64 = base64.urlsafe_b64encode(
                verification.credential_id
            ).decode().rstrip("=")

            public_key_b64 = base64.urlsafe_b64encode(
                verification.credential_public_key
            ).decode().rstrip("=")

            passkey = PasskeyCredential.objects.create(
                user=user,
                credential_id=credential_id_b64,
                public_key=public_key_b64,
                sign_count=verification.sign_count,
                aaguid=str(verification.aaguid) if verification.aaguid else "",
                device_name=device_name or "Unnamed Device",
                transports=credential_data.get("transports", []),
            )

            logger.info(f"Passkey registered for user {user.email}")
            return passkey

        except Exception as e:
            logger.error(f"Passkey registration failed: {e}")
            raise AuthenticationError(f"Failed to register passkey: {str(e)}")

    @staticmethod
    def generate_authentication_options(email: str | None = None) -> dict:
        """Generate WebAuthn authentication options."""
        # If email is provided, get user's credentials for better UX
        allow_credentials = []
        if email:
            try:
                user = User.objects.get(email=email.lower().strip(), is_active=True)
                credentials = PasskeyCredential.objects.for_user(user)
                allow_credentials = [
                    PublicKeyCredentialDescriptor(
                        id=base64.urlsafe_b64decode(cred.credential_id + "=="),
                        transports=[AuthenticatorTransport(t) for t in cred.transports] if cred.transports else None,
                    )
                    for cred in credentials
                ]
            except User.DoesNotExist:
                pass  # Don't reveal if user exists

        options = generate_authentication_options(
            rp_id=PasskeyService.RP_ID,
            allow_credentials=allow_credentials if allow_credentials else None,
            user_verification=UserVerificationRequirement.PREFERRED,
        )

        return {"publicKey": json.loads(options_to_json(options))}

    @staticmethod
    @transaction.atomic
    def verify_and_authenticate(
        credential_data: dict,
        challenge: str,
    ) -> tuple[User, PasskeyCredential]:
        """Verify authentication response and return the user."""
        try:
            # Get credential ID from response
            credential_id_raw = credential_data.get("rawId") or credential_data.get("id")
            if isinstance(credential_id_raw, str):
                credential_id_b64 = credential_id_raw.replace("+", "-").replace("/", "_").rstrip("=")
            else:
                credential_id_b64 = base64.urlsafe_b64encode(credential_id_raw).decode().rstrip("=")

            # Find the credential in database
            try:
                passkey = PasskeyCredential.objects.select_related("user").get(
                    credential_id=credential_id_b64
                )
            except PasskeyCredential.DoesNotExist:
                raise AuthenticationError("Passkey not found")

            if not passkey.user.is_active:
                raise AuthenticationError("User account is inactive")

            # Decode the stored public key
            public_key_bytes = base64.urlsafe_b64decode(passkey.public_key + "==")

            # Decode the base64url challenge back to bytes
            challenge_bytes = base64.urlsafe_b64decode(challenge + "==")

            # Verify the authentication response
            verification = verify_authentication_response(
                credential=credential_data,
                expected_challenge=challenge_bytes,
                expected_rp_id=PasskeyService.RP_ID,
                expected_origin=PasskeyService.RP_ORIGIN,
                credential_public_key=public_key_bytes,
                credential_current_sign_count=passkey.sign_count,
            )

            # Update sign count and last used timestamp
            passkey.sign_count = verification.new_sign_count
            passkey.last_used_at = timezone.now()
            passkey.save(update_fields=["sign_count", "last_used_at"])

            # Update user's last login
            passkey.user.last_login_at = timezone.now()
            passkey.user.save(update_fields=["last_login_at", "updated_at"])

            logger.info(f"Passkey authentication successful for user {passkey.user.email}")
            return passkey.user, passkey

        except Exception as e:
            logger.error(f"Passkey authentication failed: {e}")
            raise AuthenticationError(f"Failed to authenticate with passkey: {str(e)}")

    @staticmethod
    def list_credentials(user: User) -> list[PasskeyCredential]:
        """List all passkey credentials for a user."""
        return list(PasskeyCredential.objects.for_user(user).order_by("-last_used_at"))

    @staticmethod
    def delete_credential(user: User, credential_id: str) -> bool:
        """Delete a passkey credential."""
        deleted, _ = PasskeyCredential.objects.filter(
            id=credential_id, user=user
        ).delete()
        return deleted > 0


class TwoFactorService:
    """Service for handling Two-Factor Authentication with TOTP."""

    @staticmethod
    def enable_2fa(user) -> tuple[str, str]:
        """
        Enable 2FA for a user and return secret + QR code URI.
        Returns: (secret, provisioning_uri)
        """
        import pyotp
        from .models import TOTPDevice

        # Generate a new secret
        secret = pyotp.random_base32()

        # Create or update TOTP device (not verified yet)
        TOTPDevice.objects.update_or_create(
            user=user,
            defaults={"secret": secret, "is_verified": False}
        )

        # Generate provisioning URI for QR code
        totp = pyotp.TOTP(secret)
        provisioning_uri = totp.provisioning_uri(
            name=user.email,
            issuer_name="API Lens"
        )

        return secret, provisioning_uri

    @staticmethod
    def verify_and_activate_2fa(
        user, code: str,
        ip_address: str | None = None, device_info: str | None = None,
    ) -> bool:
        """Verify TOTP code and activate 2FA."""
        import pyotp
        from .models import TOTPDevice
        from .email import SecurityEmailService

        try:
            device = TOTPDevice.objects.get(user=user)
        except TOTPDevice.DoesNotExist:
            return False

        totp = pyotp.TOTP(device.secret)

        # Verify code with 1-step window (30s before/after)
        if totp.verify(code, valid_window=1):
            device.is_verified = True
            device.save()
            SecurityEmailService.send(
                user, "two_factor_enabled",
                ip_address=ip_address, device_info=device_info,
            )
            return True

        return False

    @staticmethod
    def verify_totp_code(user, code: str) -> bool:
        """Verify TOTP code during login, preventing replay within the same 30s window."""
        import time
        import pyotp
        from django.utils import timezone
        from .models import TOTPDevice

        try:
            device = TOTPDevice.objects.get(user=user, is_verified=True)
        except TOTPDevice.DoesNotExist:
            return False

        totp = pyotp.TOTP(device.secret)
        current_counter = int(time.time() // 30)

        # Check each counter in the valid window to find which one the code matches
        for delta in (-1, 0, 1):
            counter = current_counter + delta
            if totp.at(counter * 30) == code:
                # Reject if this counter was already used (replay attack)
                if device.last_used_counter is not None and counter <= device.last_used_counter:
                    return False
                device.last_used_counter = counter
                device.last_used_at = timezone.now()
                device.save(update_fields=["last_used_counter", "last_used_at"])
                return True

        return False

    @staticmethod
    def disable_2fa(
        user,
        ip_address: str | None = None, device_info: str | None = None,
    ) -> bool:
        """Disable 2FA for a user."""
        from .models import TOTPDevice, BackupCode
        from .email import SecurityEmailService

        try:
            device = TOTPDevice.objects.get(user=user)
            device.delete()
            # Also delete all backup codes
            BackupCode.objects.filter(user=user).delete()
            SecurityEmailService.send(
                user, "two_factor_disabled",
                ip_address=ip_address, device_info=device_info,
            )
            return True
        except TOTPDevice.DoesNotExist:
            return False

    @staticmethod
    def has_2fa_enabled(user) -> bool:
        """Check if user has 2FA enabled and verified."""
        from .models import TOTPDevice
        
        return TOTPDevice.objects.filter(user=user, is_verified=True).exists()

    @staticmethod
    def generate_backup_codes(user, count: int = 8) -> list[str]:
        """Generate backup codes for 2FA recovery."""
        import secrets
        import hashlib
        from .models import BackupCode

        # Delete old backup codes
        BackupCode.objects.filter(user=user).delete()

        codes = []
        for _ in range(count):
            # Generate 8-character alphanumeric code
            code = ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(8))
            code_formatted = f"{code[:4]}-{code[4:]}"  # Format as XXXX-XXXX
            codes.append(code_formatted)

            # Hash and store
            code_hash = hashlib.sha256(code.encode()).hexdigest()
            BackupCode.objects.create(user=user, code_hash=code_hash)

        return codes

    @staticmethod
    def verify_backup_code(
        user, code: str,
        ip_address: str | None = None, device_info: str | None = None,
    ) -> bool:
        """Verify and consume a backup code."""
        import hashlib
        from django.utils import timezone
        from .models import BackupCode
        from .email import SecurityEmailService

        # Remove formatting (dashes, spaces)
        code = code.replace("-", "").replace(" ", "").upper()
        code_hash = hashlib.sha256(code.encode()).hexdigest()

        try:
            backup_code = BackupCode.objects.get(
                user=user,
                code_hash=code_hash,
                is_used=False
            )
            backup_code.is_used = True
            backup_code.used_at = timezone.now()
            backup_code.save()

            remaining = BackupCode.objects.filter(user=user, is_used=False).count()
            SecurityEmailService.send(
                user, "backup_code_used",
                extra_context={"remaining_codes": remaining},
                ip_address=ip_address, device_info=device_info,
            )
            return True
        except BackupCode.DoesNotExist:
            return False

    @staticmethod
    def get_remaining_backup_codes_count(user) -> int:
        """Get count of remaining unused backup codes."""
        from .models import BackupCode
        
        return BackupCode.objects.filter(user=user, is_used=False).count()


class RecoveryService:
    """48-hour delayed account recovery for users locked out of 2FA.

    Use case: user has 2FA enabled, lost both the authenticator AND their
    backup codes. They request a recovery, receive an email with a confirm
    link and a cancel link. The legitimate user has 48 hours to cancel if it
    wasn't them. After the cooldown, clicking confirm disables 2FA, wipes
    backup codes, and revokes all sessions.
    """

    @staticmethod
    @transaction.atomic
    def request(email: str, ip_address: str | None = None) -> None:
        """Create a recovery request and email the link to the user.

        Silently no-ops when the email isn't associated with an active 2FA
        account — prevents enumeration of 2FA-enabled users.
        """
        from .models import TOTPDevice  # local import; avoids circular at module load

        email = email.lower().strip()

        try:
            user = User.objects.get(email=email, is_active=True)
        except User.DoesNotExist:
            logger.info(f"Recovery request for non-existent email: {email}")
            return

        # Only relevant for users who actually have 2FA enabled. For everyone
        # else, recovery doesn't apply — they can just sign in normally.
        if not TOTPDevice.objects.filter(user=user, is_verified=True).exists():
            logger.info(f"Recovery request for user without 2FA: {email}")
            return

        # Rate limit: at most 1 per RECOVERY_RATE_LIMIT_WINDOW per user.
        since = timezone.now() - RECOVERY_RATE_LIMIT_WINDOW
        recent = RecoveryRequest.objects.filter(user=user, requested_at__gte=since).count()
        if recent >= 1:
            raise RateLimitError("You can only request account recovery once per 24 hours.")

        # Cancel any older pending request so the latest one is the only valid path.
        RecoveryRequest.objects.filter(
            user=user, status=RecoveryRequest.STATUS_PENDING,
        ).update(status=RecoveryRequest.STATUS_CANCELLED)

        raw_token = secrets.token_urlsafe(48)
        now = timezone.now()
        available_at = now + RECOVERY_COOLDOWN
        expires_at = available_at + RECOVERY_GRACE

        RecoveryRequest.objects.create(
            user=user,
            token_hash=_hash_token(raw_token),
            available_at=available_at,
            expires_at=expires_at,
            ip_address=ip_address,
        )

        # Send the email with both confirm and cancel URLs.
        frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
        confirm_url = f"{frontend_url}/auth/recovery?token={raw_token}"
        cancel_url = f"{frontend_url}/auth/recovery?token={raw_token}&action=cancel"

        from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai")
        context = {
            "email": user.email,
            "display_name": user.display_name or user.email,
            "confirm_url": confirm_url,
            "cancel_url": cancel_url,
            "available_at": available_at,
            "ip_address": ip_address or "Unknown",
            "cooldown_hours": int(RECOVERY_COOLDOWN.total_seconds() // 3600),
        }
        try:
            plain_text = render_to_string("auth/emails/recovery_requested.txt", context)
            html_content = render_to_string("auth/emails/recovery_requested.html", context)
            msg = EmailMultiAlternatives(
                subject="Account recovery requested for API Lens",
                body=plain_text,
                from_email=from_email,
                to=[email],
            )
            msg.attach_alternative(html_content, "text/html")
            msg.send(fail_silently=False)
            logger.info(f"Recovery email sent to {email}")
        except Exception as exc:
            # Don't roll back the RecoveryRequest — the user can ask again,
            # but log loudly because they may need to.
            logger.exception(f"Failed to send recovery email to {email}: {exc}")

    @staticmethod
    def get_status(raw_token: str) -> dict:
        """Public status lookup by token. Returns minimal info — never throws
        on bad tokens to avoid leaking which tokens exist."""
        token_hash = _hash_token(raw_token)
        try:
            req = RecoveryRequest.objects.select_related("user").get(token_hash=token_hash)
        except RecoveryRequest.DoesNotExist:
            return {"status": "invalid"}

        now = timezone.now()
        if req.status == RecoveryRequest.STATUS_CONFIRMED:
            return {"status": "confirmed", "email": req.user.email}
        if req.status == RecoveryRequest.STATUS_CANCELLED:
            return {"status": "cancelled", "email": req.user.email}
        if req.expires_at <= now:
            return {"status": "expired", "email": req.user.email}

        return {
            "status": "pending",
            "email": req.user.email,
            "requested_at": req.requested_at.isoformat(),
            "available_at": req.available_at.isoformat(),
            "expires_at": req.expires_at.isoformat(),
            "is_ready": req.available_at <= now,
        }

    @staticmethod
    @transaction.atomic
    def confirm(raw_token: str, ip_address: str | None = None, device_info: str | None = None) -> User:
        """After the cooldown has elapsed, disable 2FA + wipe codes + revoke sessions.

        Raises TokenInvalidError / TokenExpiredError on bad input.
        """
        from .models import TOTPDevice, BackupCode

        token_hash = _hash_token(raw_token)
        try:
            req = RecoveryRequest.objects.select_for_update().select_related("user").get(token_hash=token_hash)
        except RecoveryRequest.DoesNotExist:
            raise TokenInvalidError("Invalid recovery link")

        if req.status != RecoveryRequest.STATUS_PENDING:
            raise TokenInvalidError("This recovery link has already been used or cancelled")

        now = timezone.now()
        if req.expires_at <= now:
            raise TokenExpiredError("This recovery link has expired. Request a new one.")
        if req.available_at > now:
            # Cooldown not done yet.
            raise TokenInvalidError("The cooldown hasn't elapsed yet — check back later.")

        # Disable 2FA on the user's account.
        TOTPDevice.objects.filter(user=req.user).delete()
        BackupCode.objects.filter(user=req.user).delete()

        # Revoke every active session so any attacker holding stolen tokens
        # loses them at the same moment 2FA is removed.
        TokenService.revoke_all_for_user(req.user)

        req.status = RecoveryRequest.STATUS_CONFIRMED
        req.save(update_fields=["status"])

        # Tell the user what happened — reuse the standard "2FA disabled"
        # security email so they always get the same signal.
        from .email import SecurityEmailService
        SecurityEmailService.send(
            req.user, "two_factor_disabled",
            ip_address=ip_address, device_info=device_info,
        )

        logger.info(f"Recovery confirmed for {req.user.email}; 2FA disabled")
        return req.user

    @staticmethod
    @transaction.atomic
    def cancel(raw_token: str) -> None:
        """One-click "this wasn't me" — invalidates the pending request immediately.

        Idempotent and safe to call on a non-pending request (no-op).
        """
        token_hash = _hash_token(raw_token)
        try:
            req = RecoveryRequest.objects.select_for_update().get(token_hash=token_hash)
        except RecoveryRequest.DoesNotExist:
            raise TokenInvalidError("Invalid recovery link")

        # If it's already confirmed, we can't un-do that.
        if req.status == RecoveryRequest.STATUS_CONFIRMED:
            raise TokenInvalidError("This recovery has already been completed and can't be cancelled.")

        if req.status == RecoveryRequest.STATUS_PENDING:
            req.status = RecoveryRequest.STATUS_CANCELLED
            req.save(update_fields=["status"])
            logger.info(f"Recovery cancelled for {req.user.email}")
