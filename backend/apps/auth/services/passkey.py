"""WebAuthn / passkey enrollment + authentication."""

import base64
import json
import logging

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.cose import COSEAlgorithmIdentifier
from webauthn.helpers.structs import (
    AuthenticatorAttachment,
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from apps.users.models import User
from core.exceptions.base import AuthenticationError

from ..models import PasskeyCredential

logger = logging.getLogger(__name__)


class PasskeyService:
    """WebAuthn / passkey relying-party logic."""

    # RP_ID is the domain the browser binds the credential to. Set via env in
    # production (`WEBAUTHN_RP_ID=apilens.ai`); falls back to localhost for dev.
    RP_ID = getattr(settings, "WEBAUTHN_RP_ID", "localhost")
    RP_NAME = getattr(settings, "WEBAUTHN_RP_NAME", "API Lens")
    RP_ORIGIN = getattr(settings, "FRONTEND_URL", "http://localhost:3000")

    @staticmethod
    def generate_registration_options(user: User) -> dict:
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
                # Bind to the device's built-in biometric (Touch ID, Face ID,
                # Windows Hello). Without this, mobile Safari especially defaults
                # to "use a passkey from another device" via QR.
                authenticator_attachment=AuthenticatorAttachment.PLATFORM,
                resident_key=ResidentKeyRequirement.PREFERRED,
                user_verification=UserVerificationRequirement.PREFERRED,
            ),
            supported_pub_key_algs=[
                COSEAlgorithmIdentifier.ECDSA_SHA_256,
                COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256,
            ],
        )

        # Challenge ships to the client; the verify step gets it back.
        return {"publicKey": json.loads(options_to_json(options))}

    @staticmethod
    @transaction.atomic
    def verify_and_save_credential(
        user: User,
        credential_data: dict,
        challenge: str,
        device_name: str = "",
    ) -> PasskeyCredential:
        try:
            challenge_bytes = base64.urlsafe_b64decode(challenge + "==")

            verification = verify_registration_response(
                credential=credential_data,
                expected_challenge=challenge_bytes,
                expected_rp_id=PasskeyService.RP_ID,
                expected_origin=PasskeyService.RP_ORIGIN,
            )

            credential_id_b64 = (
                base64.urlsafe_b64encode(verification.credential_id).decode().rstrip("=")
            )
            public_key_b64 = (
                base64.urlsafe_b64encode(verification.credential_public_key)
                .decode()
                .rstrip("=")
            )

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
        allow_credentials = []
        if email:
            # Don't reveal whether the user exists — silently fall back to
            # "any credential" if the lookup fails.
            try:
                user = User.objects.get(email=email.lower().strip(), is_active=True)
                credentials = PasskeyCredential.objects.for_user(user)
                allow_credentials = [
                    PublicKeyCredentialDescriptor(
                        id=base64.urlsafe_b64decode(cred.credential_id + "=="),
                        transports=(
                            [AuthenticatorTransport(t) for t in cred.transports]
                            if cred.transports
                            else None
                        ),
                    )
                    for cred in credentials
                ]
            except User.DoesNotExist:
                pass

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
        try:
            credential_id_raw = credential_data.get("rawId") or credential_data.get("id")
            if isinstance(credential_id_raw, str):
                credential_id_b64 = (
                    credential_id_raw.replace("+", "-").replace("/", "_").rstrip("=")
                )
            else:
                credential_id_b64 = (
                    base64.urlsafe_b64encode(credential_id_raw).decode().rstrip("=")
                )

            try:
                passkey = PasskeyCredential.objects.select_related("user").get(
                    credential_id=credential_id_b64
                )
            except PasskeyCredential.DoesNotExist:
                raise AuthenticationError("Passkey not found")

            if not passkey.user.is_active:
                raise AuthenticationError("User account is inactive")

            public_key_bytes = base64.urlsafe_b64decode(passkey.public_key + "==")
            challenge_bytes = base64.urlsafe_b64decode(challenge + "==")

            verification = verify_authentication_response(
                credential=credential_data,
                expected_challenge=challenge_bytes,
                expected_rp_id=PasskeyService.RP_ID,
                expected_origin=PasskeyService.RP_ORIGIN,
                credential_public_key=public_key_bytes,
                credential_current_sign_count=passkey.sign_count,
            )

            passkey.sign_count = verification.new_sign_count
            passkey.last_used_at = timezone.now()
            passkey.save(update_fields=["sign_count", "last_used_at"])

            passkey.user.last_login_at = timezone.now()
            passkey.user.save(update_fields=["last_login_at", "updated_at"])

            logger.info(f"Passkey authentication successful for user {passkey.user.email}")
            return passkey.user, passkey

        except Exception as e:
            logger.error(f"Passkey authentication failed: {e}")
            raise AuthenticationError(f"Failed to authenticate with passkey: {str(e)}")

    @staticmethod
    def list_credentials(user: User) -> list[PasskeyCredential]:
        return list(PasskeyCredential.objects.for_user(user).order_by("-last_used_at"))

    @staticmethod
    def delete_credential(user: User, credential_id: str) -> bool:
        deleted, _ = PasskeyCredential.objects.filter(
            id=credential_id, user=user
        ).delete()
        return deleted > 0
