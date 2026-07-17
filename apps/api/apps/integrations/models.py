"""Source-code integrations (Phase 1 "Code Link" of the AI-native plan).

Three levels, deliberately (see PHASE1_CODE_LINK_DESIGN.md):

    Project ──< GitHubInstallation   "this project may read these GitHub accounts"
    Project ──< Repository           "these repos are linked to this project"
    App     ──< CodeMapping ──> Repository

CodeMappings are APP-level so monorepos (many apps → one repo, different
source roots) and polyrepos (one repo per app) both fit without special cases.
"""

import uuid

from django.conf import settings
from django.db import models


class GitHubInstallation(models.Model):
    """One (project, GitHub App installation) link.

    The same GitHub installation may be linked to several APILens projects;
    webhook handlers therefore match on installation_id across all rows.
    Tokens are minted on demand and never stored here.
    """

    class Status(models.TextChoices):
        ACTIVE = "active"
        SUSPENDED = "suspended"
        REVOKED = "revoked"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="github_installations",
    )
    installation_id = models.BigIntegerField()
    account_login = models.CharField(max_length=256)
    account_type = models.CharField(max_length=32, blank=True, default="")
    repository_selection = models.CharField(max_length=16, blank=True, default="")
    # "" = github.com; a GHES host later (Sentry's documented gap).
    base_url = models.CharField(max_length=256, blank=True, default="")
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.ACTIVE, db_index=True
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "github_installations"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "installation_id"],
                name="unique_installation_per_project",
            ),
        ]

    def __str__(self):
        return f"gh install {self.installation_id} ({self.account_login}) -> {self.project_id}"


class Repository(models.Model):
    """A GitHub repository explicitly linked to a project.

    Keyed by GitHub's numeric id (stable across renames); full_name is
    refreshed opportunistically. is_active flips false when the installation
    loses access (installation_repositories/removed webhook) or is revoked.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="repositories",
    )
    installation = models.ForeignKey(
        GitHubInstallation,
        on_delete=models.CASCADE,
        related_name="repositories",
    )
    external_id = models.BigIntegerField()
    full_name = models.CharField(max_length=300)
    default_branch = models.CharField(max_length=128, blank=True, default="main")
    private = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "repositories"
        ordering = ["full_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "external_id"],
                name="unique_repo_per_project",
            ),
        ]

    def __str__(self):
        return f"repo {self.full_name} -> {self.project_id}"


class CodeMapping(models.Model):
    """Maps an app's runtime stack-trace paths into a repository.

    resolve: runtime_path.startswith(stack_trace_root) → source_root +
    remainder. Longest stack_trace_root prefix wins when an app has several
    mappings. Frames matching no mapping are treated as not-in-app.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    app = models.ForeignKey(
        "projects.App",
        on_delete=models.CASCADE,
        related_name="code_mappings",
    )
    repository = models.ForeignKey(
        Repository,
        on_delete=models.CASCADE,
        related_name="code_mappings",
    )
    # Runtime path prefix as seen in tracebacks, e.g. "/app/" or "/usr/src/app/".
    stack_trace_root = models.CharField(max_length=300)
    # Repo path prefix, e.g. "" (repo root) or "services/checkout/" (monorepo).
    source_root = models.CharField(max_length=300, blank=True, default="")
    # "" → the repository's default branch.
    branch = models.CharField(max_length=128, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "code_mappings"
        ordering = ["app_id", "-stack_trace_root"]
        constraints = [
            models.UniqueConstraint(
                fields=["app", "stack_trace_root"],
                name="unique_mapping_root_per_app",
            ),
        ]

    def __str__(self):
        return f"map {self.stack_trace_root} -> {self.repository_id}:{self.source_root}"
