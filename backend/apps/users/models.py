"""
Custom User model with Auth0 integration.

This model extends Django's AbstractUser to store Auth0-specific data
while maintaining compatibility with Django's authentication system.
"""

import uuid
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """
    Custom User model that syncs with Auth0.

    The auth0_id field stores the 'sub' claim from Auth0 JWT tokens,
    which is the unique identifier for users across all Auth0 connections.
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )

    auth0_id = models.CharField(
        max_length=255,
        unique=True,
        db_index=True,
        help_text="Auth0 user ID (sub claim from JWT)",
    )

    email = models.EmailField(
        unique=True,
        db_index=True,
    )

    picture = models.URLField(
        max_length=500,
        blank=True,
        default="",
    )

    email_verified = models.BooleanField(
        default=False,
    )

    auth0_connection = models.CharField(
        max_length=100,
        blank=True,
        default="",
    )

    metadata = models.JSONField(
        default=dict,
        blank=True,
        help_text="Additional metadata from Auth0",
    )

    last_login_at = models.DateTimeField(null=True, blank=True)
    last_synced_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    username = models.CharField(max_length=150, unique=True, blank=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["auth0_id"]

    class Meta:
        db_table = "users"
        verbose_name = "User"
        verbose_name_plural = "Users"
        ordering = ["-created_at"]

    def __str__(self):
        return self.email or self.auth0_id

    def save(self, *args, **kwargs):
        if not self.username:
            self.username = self.auth0_id.replace("|", "_")[:150]
        super().save(*args, **kwargs)

    @property
    def display_name(self) -> str:
        if self.first_name and self.last_name:
            return f"{self.first_name} {self.last_name}"
        if self.first_name:
            return self.first_name
        return self.email.split("@")[0] if self.email else self.auth0_id

    @property
    def provider(self) -> str:
        if "|" in self.auth0_id:
            return self.auth0_id.split("|")[0]
        return "unknown"
