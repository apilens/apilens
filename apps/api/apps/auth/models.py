import uuid

from django.conf import settings
from django.db import models

from .managers import (
    RefreshTokenManager,
    MagicLinkTokenManager,
    ApiKeyManager,
    PasswordResetTokenManager,
    PasskeyCredentialManager,
)


class RefreshToken(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="refresh_tokens",
    )
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    token_family = models.UUIDField(default=uuid.uuid4, db_index=True)
    expires_at = models.DateTimeField(db_index=True)
    is_revoked = models.BooleanField(default=False)
    device_info = models.CharField(max_length=255, blank=True, default="")
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    location = models.CharField(max_length=100, blank=True, default="")
    last_used_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = RefreshTokenManager()

    class Meta:
        db_table = "auth_refresh_tokens"
        ordering = ["-created_at"]

    def __str__(self):
        return f"RefreshToken({self.user_id}, revoked={self.is_revoked})"

    @property
    def is_expired(self):
        from django.utils import timezone
        return self.expires_at <= timezone.now()

    @property
    def is_valid(self):
        return not self.is_revoked and not self.is_expired


class MagicLinkToken(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(db_index=True)
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    expires_at = models.DateTimeField()
    is_used = models.BooleanField(default=False)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = MagicLinkTokenManager()

    class Meta:
        db_table = "auth_magic_link_tokens"
        ordering = ["-created_at"]

    def __str__(self):
        return f"MagicLink({self.email}, used={self.is_used})"

    @property
    def is_expired(self):
        from django.utils import timezone
        return self.expires_at <= timezone.now()

    @property
    def is_valid(self):
        return not self.is_used and not self.is_expired


class PasswordResetToken(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(db_index=True)
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    expires_at = models.DateTimeField()
    is_used = models.BooleanField(default=False)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = PasswordResetTokenManager()

    class Meta:
        db_table = "auth_password_reset_tokens"
        ordering = ["-created_at"]

    def __str__(self):
        return f"PasswordReset({self.email}, used={self.is_used})"

    @property
    def is_expired(self):
        from django.utils import timezone
        return self.expires_at <= timezone.now()

    @property
    def is_valid(self):
        return not self.is_used and not self.is_expired


class PasskeyCredential(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="passkey_credentials",
    )
    credential_id = models.TextField(unique=True, db_index=True)
    public_key = models.TextField()
    sign_count = models.IntegerField(default=0)
    transports = models.JSONField(default=list, blank=True)
    aaguid = models.CharField(max_length=36, blank=True, default="")
    device_name = models.CharField(max_length=100, blank=True, default="")
    last_used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = PasskeyCredentialManager()

    class Meta:
        db_table = "auth_passkey_credentials"
        ordering = ["-created_at"]

    def __str__(self):
        return f"Passkey({self.user.email}, {self.device_name or 'unnamed'})"


class ApiKey(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="api_keys",
    )
    # App-scoped keys bind directly to one app, so SDKs need only the key
    # (project + app are derived server-side). Null = legacy project-scoped key
    # that identifies the app per-record via app_id.
    app = models.ForeignKey(
        "projects.App",
        on_delete=models.CASCADE,
        related_name="api_keys",
        null=True,
        blank=True,
    )
    key_hash = models.CharField(max_length=64, unique=True, db_index=True)
    prefix = models.CharField(max_length=16)
    name = models.CharField(max_length=100)
    is_revoked = models.BooleanField(default=False)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = ApiKeyManager()

    class Meta:
        db_table = "auth_api_keys"
        ordering = ["-created_at"]

    def __str__(self):
        return f"ApiKey({self.prefix}..., project={self.project_id})"

    @property
    def is_expired(self):
        if self.expires_at is None:
            return False
        from django.utils import timezone
        return self.expires_at <= timezone.now()

    @property
    def is_valid(self):
        return not self.is_revoked and not self.is_expired


class TOTPDevice(models.Model):
    """Two-Factor Authentication TOTP device."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="totp_device",
    )
    secret = models.CharField(max_length=32)  # Base32 encoded secret
    is_verified = models.BooleanField(default=False)
    last_used_at = models.DateTimeField(null=True, blank=True)
    last_used_counter = models.IntegerField(null=True, blank=True)  # TOTP replay prevention
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "auth_totp_devices"

    def __str__(self):
        return f"TOTP({self.user.email}, verified={self.is_verified})"


class RecoveryRequest(models.Model):
    """Pending 48-hour 2FA-recovery request.

    Created when a user who's lost their authenticator AND backup codes asks
    to disable 2FA. The cooldown gives the legitimate account holder time to
    cancel if they didn't initiate the request. After `available_at`, clicking
    the confirm link disables 2FA and revokes all sessions.
    """
    STATUS_PENDING = "pending"
    STATUS_CONFIRMED = "confirmed"
    STATUS_CANCELLED = "cancelled"

    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_CONFIRMED, "Confirmed"),
        (STATUS_CANCELLED, "Cancelled"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="recovery_requests",
    )
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    requested_at = models.DateTimeField(auto_now_add=True)
    # Earliest time the recovery can be confirmed (requested_at + cooldown).
    available_at = models.DateTimeField()
    # When the token stops being valid (available_at + grace window).
    expires_at = models.DateTimeField(db_index=True)
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING, db_index=True,
    )
    ip_address = models.GenericIPAddressField(null=True, blank=True)

    class Meta:
        db_table = "auth_recovery_requests"
        ordering = ["-requested_at"]

    def __str__(self):
        return f"RecoveryRequest({self.user.email}, status={self.status})"

    @property
    def is_expired(self) -> bool:
        from django.utils import timezone
        return self.expires_at <= timezone.now()

    @property
    def is_ready(self) -> bool:
        """True when the cooldown has elapsed and the request can be confirmed."""
        from django.utils import timezone
        return (
            self.status == self.STATUS_PENDING
            and self.available_at <= timezone.now()
            and not self.is_expired
        )


class BackupCode(models.Model):
    """Backup codes for 2FA recovery."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="backup_codes",
    )
    code_hash = models.CharField(max_length=64, db_index=True)
    is_used = models.BooleanField(default=False)
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "auth_backup_codes"
        ordering = ["-created_at"]

    def __str__(self):
        return f"BackupCode({self.user.email}, used={self.is_used})"
