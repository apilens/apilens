from django.db import models
from django.utils import timezone


class RefreshTokenManager(models.Manager):
    def active(self):
        return self.filter(is_revoked=False, expires_at__gt=timezone.now())

    def for_user(self, user):
        return self.active().filter(user=user)

    def cleanup_expired(self):
        return self.filter(expires_at__lte=timezone.now()).delete()


class ApiKeyManager(models.Manager):
    def active(self):
        qs = self.filter(is_revoked=False)
        return qs.exclude(expires_at__lte=timezone.now())

    def for_user(self, user):
        return self.active().filter(user=user)


class MagicLinkTokenManager(models.Manager):
    def active(self):
        return self.filter(is_used=False, expires_at__gt=timezone.now())

    def cleanup_expired(self):
        return self.filter(expires_at__lte=timezone.now()).delete()
