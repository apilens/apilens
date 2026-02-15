import uuid

from django.conf import settings
from django.db import models

from .managers import AppManager, EndpointManager, EnvironmentManager


def app_icon_path(instance, filename):
    return f"app_icons/{instance.id}.jpg"


class App(models.Model):
    class Framework(models.TextChoices):
        FASTAPI = "fastapi"
        FLASK = "flask"
        DJANGO = "django"
        STARLETTE = "starlette"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="apps",
    )
    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=120, db_index=True)
    icon = models.CharField(max_length=8, blank=True, default="")
    icon_image = models.ImageField(upload_to=app_icon_path, blank=True, default="")
    description = models.TextField(blank=True, default="")
    framework = models.CharField(
        max_length=24,
        choices=Framework.choices,
        default=Framework.FASTAPI,
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = AppManager()

    class Meta:
        db_table = "apps"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "slug"],
                name="unique_app_slug_per_owner",
            ),
        ]

    def __str__(self):
        return f"{self.name} ({self.slug})"


class Endpoint(models.Model):
    """
    Represents a monitored API endpoint belonging to an App.
    """

    class Method(models.TextChoices):
        GET = "GET"
        POST = "POST"
        PUT = "PUT"
        PATCH = "PATCH"
        DELETE = "DELETE"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    app = models.ForeignKey(
        "projects.App",
        on_delete=models.CASCADE,
        related_name="endpoints",
    )
    path = models.CharField(max_length=500)
    method = models.CharField(max_length=10, choices=Method.choices, default=Method.GET)
    description = models.TextField(blank=True, default="")
    is_active = models.BooleanField(default=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = EndpointManager()

    class Meta:
        db_table = "endpoints"
        ordering = ["path", "method"]
        constraints = [
            models.UniqueConstraint(
                fields=["app", "path", "method"],
                name="unique_endpoint_per_app",
            ),
        ]

    def __str__(self):
        return f"{self.method} {self.path}"


class Environment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    app = models.ForeignKey(
        "projects.App",
        on_delete=models.CASCADE,
        related_name="environments",
    )
    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=120)
    color = models.CharField(max_length=7, default="#6b7280")
    order = models.PositiveSmallIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = EnvironmentManager()

    class Meta:
        db_table = "environments"
        ordering = ["order", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["app", "slug"],
                name="unique_environment_slug_per_app",
            ),
        ]

    def __str__(self):
        return f"{self.name} ({self.app.name})"
