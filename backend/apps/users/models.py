import uuid

from django.contrib.auth.models import AbstractUser
from django.db import models


def profile_picture_path(instance, filename):
    return f"profile_pictures/{instance.id}.jpg"


class User(AbstractUser):
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )

    email = models.EmailField(unique=True, db_index=True)

    picture = models.ImageField(
        upload_to=profile_picture_path,
        blank=True,
        default="",
    )

    email_verified = models.BooleanField(default=False)

    auth_provider = models.CharField(
        max_length=50,
        default="magic_link",
    )

    metadata = models.JSONField(default=dict, blank=True)

    last_login_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    username = models.CharField(max_length=150, unique=True, blank=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    class Meta:
        db_table = "users"
        verbose_name = "User"
        verbose_name_plural = "Users"
        ordering = ["-created_at"]

    def __str__(self):
        return self.email

    def save(self, *args, **kwargs):
        if not self.username:
            self.username = str(self.id)[:150]
        super().save(*args, **kwargs)

    @property
    def display_name(self) -> str:
        if self.first_name and self.last_name:
            return f"{self.first_name} {self.last_name}"
        if self.first_name:
            return self.first_name
        return self.email.split("@")[0] if self.email else str(self.id)
