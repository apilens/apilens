import uuid

from django.conf import settings
from django.db import models

from .managers import RefreshTokenManager, MagicLinkTokenManager, ApiKeyManager


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


class ApiKey(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="api_keys",
        null=True,
        blank=True,
    )
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
        return f"ApiKey({self.prefix}..., user={self.user_id})"

    @property
    def is_expired(self):
        if self.expires_at is None:
            return False
        from django.utils import timezone
        return self.expires_at <= timezone.now()

    @property
    def is_valid(self):
        return not self.is_revoked and not self.is_expired
