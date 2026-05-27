"""
Base Django model classes for apilens.
"""

from django.db import models


class TimestampedModel(models.Model):
    """
    Abstract base model that provides automatic created_at and updated_at timestamps.
    """

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True
        ordering = ["-created_at"]


class TenantModel(TimestampedModel):
    """
    Abstract base model for multi-tenant data.
    Extends TimestampedModel with a tenant_id field.
    """

    tenant_id = models.UUIDField(db_index=True)

    class Meta:
        abstract = True
        indexes = [
            models.Index(fields=["tenant_id", "created_at"]),
        ]
