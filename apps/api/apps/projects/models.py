import uuid

from django.conf import settings
from django.db import models

from .managers import ProjectManager, AppManager, EndpointManager, EnvironmentManager


def app_icon_path(instance, filename):
    return f"app_icons/{instance.id}.jpg"


class Project(models.Model):
    """
    Represents a top-level organizational unit for grouping related apps/services.
    Projects own API keys and provide aggregated analytics.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="projects",
    )
    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=120, db_index=True)
    description = models.TextField(blank=True, default="")
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ProjectManager()

    class Meta:
        db_table = "projects"
        ordering = ["-created_at"]
        constraints = [
            # Project slugs (and therefore names) are globally unique across all
            # users. Scoped to active rows so a soft-deleted project frees its
            # name for reuse.
            models.UniqueConstraint(
                fields=["slug"],
                condition=models.Q(is_active=True),
                name="unique_active_project_slug",
            ),
        ]

    def __str__(self):
        return f"{self.name} ({self.slug})"


class App(models.Model):
    class Framework(models.TextChoices):
        FASTAPI = "fastapi"
        FLASK = "flask"
        DJANGO = "django"
        STARLETTE = "starlette"
        EXPRESS = "express"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
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
                fields=["project", "slug"],
                name="unique_app_slug_per_project",
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


class ProjectMember(models.Model):
    """A user's role-based membership in a project (RBAC subject).

    The project's `owner` is the authoritative owner and is NOT stored here;
    membership rows cover collaborators (admin / member / viewer). Effective role
    resolution prefers Project.owner, then this table.
    """

    class Role(models.TextChoices):
        OWNER = "owner", "Owner"
        ADMIN = "admin", "Admin"
        MEMBER = "member", "Member"
        VIEWER = "viewer", "Viewer"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, related_name="members"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="project_memberships",
    )
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.MEMBER)
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "project_members"
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "user"], name="unique_member_per_project"
            ),
        ]

    def __str__(self):
        return f"{self.user_id} @ {self.project_id} ({self.role})"


class ProjectInvitation(models.Model):
    """A pending email invitation to join a project with a role.

    The invitee must explicitly accept (from the notification bell or the invite
    link); accepting creates the ProjectMember row. The magic-link flow
    auto-creates the account on first sign-in, but membership is never granted
    without an explicit accept. The invitee may also decline.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REVOKED = "revoked", "Revoked"
        DECLINED = "declined", "Declined"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, related_name="invitations"
    )
    email = models.EmailField(db_index=True)
    role = models.CharField(
        max_length=20,
        choices=ProjectMember.Role.choices,
        default=ProjectMember.Role.MEMBER,
    )
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "project_invitations"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["email", "status"])]

    @property
    def is_expired(self) -> bool:
        from django.utils import timezone

        return self.expires_at <= timezone.now()

    def __str__(self):
        return f"invite {self.email} -> {self.project_id} ({self.role}, {self.status})"
