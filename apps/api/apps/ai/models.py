"""AI Investigator (Phase 2 of the AI-native plan).

One Investigation row per run of the staged RCA pipeline over an error issue.
The pipeline is Seer-style: evidence assembly (deterministic, from our own
stores) → root-cause analysis → fix plan, each stage a structured Agno agent
call. Results are stored whole so the Errors page can render the evidence
trail without re-running anything.
"""

import uuid

from django.conf import settings
from django.db import models


class Investigation(models.Model):
    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        COMPLETED = "completed"
        FAILED = "failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="investigations",
    )
    # The error issue under investigation (ErrorIssue.fingerprint).
    fingerprint = models.CharField(max_length=40, db_index=True)
    issue_title = models.CharField(max_length=300, blank=True, default="")
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED, db_index=True
    )

    # Stage 1 — root cause.
    root_cause = models.TextField(blank=True, default="")
    confidence = models.CharField(max_length=8, blank=True, default="")  # high|medium|low
    explanation = models.TextField(blank=True, default="")
    impact_summary = models.TextField(blank=True, default="")
    # [{source, detail}] — which evidence the model actually cited.
    evidence = models.JSONField(default=list, blank=True)

    # Stage 2 — fix plan.
    fix_steps = models.JSONField(default=list, blank=True)  # [str]
    patch_suggestion = models.TextField(blank=True, default="")
    risk_notes = models.TextField(blank=True, default="")

    # Cost metering.
    model = models.CharField(max_length=64, blank=True, default="")
    input_tokens = models.BigIntegerField(default=0)
    output_tokens = models.BigIntegerField(default=0)

    error = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "investigations"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["project", "fingerprint", "created_at"])]

    def __str__(self):
        return f"investigation {self.fingerprint[:8]} ({self.status})"


class Postmortem(models.Model):
    """An auto-drafted incident postmortem for one error issue (Phase 6,
    feature F7). Mostly retrieval (issue + investigation + deploys +
    verification + fix handoffs) with a single LLM synthesis pass; stored
    whole and regenerable so the Errors page renders it without re-running."""

    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        COMPLETED = "completed"
        FAILED = "failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, related_name="postmortems"
    )
    fingerprint = models.CharField(max_length=40, db_index=True)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED
    )
    title = models.CharField(max_length=300, blank=True, default="")
    summary = models.TextField(blank=True, default="")
    markdown = models.TextField(blank=True, default="")
    model = models.CharField(max_length=64, blank=True, default="")
    input_tokens = models.BigIntegerField(default=0)
    output_tokens = models.BigIntegerField(default=0)
    error = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "postmortems"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["project", "fingerprint", "created_at"])]

    def __str__(self):
        return f"postmortem {self.fingerprint[:8]} ({self.status})"
