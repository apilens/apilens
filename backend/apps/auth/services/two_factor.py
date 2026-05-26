"""TOTP enrollment, verification (with replay protection), and backup codes."""

import hashlib
import logging
import secrets
import time

import pyotp
from django.utils import timezone

from ..models import BackupCode, TOTPDevice

logger = logging.getLogger(__name__)


class TwoFactorService:
    """TOTP-backed Two-Factor Authentication."""

    @staticmethod
    def enable_2fa(user) -> tuple[str, str]:
        """Generate a fresh TOTP secret + provisioning URI. Not verified yet —
        caller must call `verify_and_activate_2fa` with a code from the user's
        authenticator app to flip the device to verified."""
        secret = pyotp.random_base32()

        TOTPDevice.objects.update_or_create(
            user=user,
            defaults={"secret": secret, "is_verified": False},
        )

        totp = pyotp.TOTP(secret)
        provisioning_uri = totp.provisioning_uri(name=user.email, issuer_name="API Lens")

        return secret, provisioning_uri

    @staticmethod
    def verify_and_activate_2fa(
        user,
        code: str,
        ip_address: str | None = None,
        device_info: str | None = None,
    ) -> bool:
        from ..email import SecurityEmailService

        try:
            device = TOTPDevice.objects.get(user=user)
        except TOTPDevice.DoesNotExist:
            return False

        totp = pyotp.TOTP(device.secret)

        # 1-step window = ±30s, tolerates small clock skew.
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
        """Verify a TOTP code during login. Rejects replay within the same 30s window."""
        try:
            device = TOTPDevice.objects.get(user=user, is_verified=True)
        except TOTPDevice.DoesNotExist:
            return False

        totp = pyotp.TOTP(device.secret)
        current_counter = int(time.time() // 30)

        # Try each counter in the ±1 window and see which one the code matches.
        for delta in (-1, 0, 1):
            counter = current_counter + delta
            if totp.at(counter * 30) == code:
                # Replay guard: counters monotonically increase per user.
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
        ip_address: str | None = None,
        device_info: str | None = None,
    ) -> bool:
        from ..email import SecurityEmailService

        try:
            device = TOTPDevice.objects.get(user=user)
            device.delete()
            # Drop backup codes too — they're useless without the TOTP secret.
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
        return TOTPDevice.objects.filter(user=user, is_verified=True).exists()

    @staticmethod
    def generate_backup_codes(user, count: int = 8) -> list[str]:
        # Wipe old codes — any new generation invalidates the previous batch.
        BackupCode.objects.filter(user=user).delete()

        codes = []
        for _ in range(count):
            # 8 chars from a confusable-free alphabet, formatted XXXX-XXXX.
            code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
            code_formatted = f"{code[:4]}-{code[4:]}"
            codes.append(code_formatted)

            code_hash = hashlib.sha256(code.encode()).hexdigest()
            BackupCode.objects.create(user=user, code_hash=code_hash)

        return codes

    @staticmethod
    def verify_backup_code(
        user,
        code: str,
        ip_address: str | None = None,
        device_info: str | None = None,
    ) -> bool:
        from ..email import SecurityEmailService

        # Tolerate display formatting (dashes, spaces).
        code = code.replace("-", "").replace(" ", "").upper()
        code_hash = hashlib.sha256(code.encode()).hexdigest()

        try:
            backup_code = BackupCode.objects.get(
                user=user, code_hash=code_hash, is_used=False,
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
        return BackupCode.objects.filter(user=user, is_used=False).count()
