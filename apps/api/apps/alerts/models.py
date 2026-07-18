"""The Sentinel (Phase 5) — alerting data model.

Two rule families (the Sentry split, see PHASE5_SENTINEL_DESIGN.md):
issue rules fire on lifecycle transitions delivered through the AlertSignal
outbox the ingest service writes; metric monitors are evaluated on a loop by
`manage.py run_sentinel` against ClickHouse windows. State follows the
Grafana/Prometheus canon (ok → pending → firing, transitions-only
notifications) and persists in Postgres so the evaluator restarts cleanly.
"""

import uuid

from django.conf import settings
from django.db import models


class AlertChannel(models.Model):
    """A notification destination. config by kind:
    slack_webhook: {"url"} · webhook: {"url"} · email: {"emails": [...]}."""

    class Kind(models.TextChoices):
        SLACK_WEBHOOK = "slack_webhook"
        WEBHOOK = "webhook"
        EMAIL = "email"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, related_name="alert_channels"
    )
    kind = models.CharField(max_length=16, choices=Kind.choices)
    name = models.CharField(max_length=100)
    config = models.JSONField(default=dict)
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "alert_channels"
        ordering = ["name"]

    def __str__(self):
        return f"channel {self.kind}:{self.name}"


class AlertRule(models.Model):
    """One alert rule.

    kind=new_issue|regression → event-driven (signals), metric fields unused.
    kind=metric → scheduled monitor: `metric` over `window_minutes`, either a
    static threshold (comparison+threshold) or an anomaly band
    (threshold_type=anomaly, direction+sensitivity). group_by=consumer gives
    Datadog-style multi-alert: one state per consumer (static only)."""

    class Kind(models.TextChoices):
        NEW_ISSUE = "new_issue"
        REGRESSION = "regression"
        METRIC = "metric"

    class Metric(models.TextChoices):
        ERROR_RATE = "error_rate"
        SERVER_ERROR_RATE = "server_error_rate"
        CLIENT_ERROR_RATE = "client_error_rate"
        REQUEST_COUNT = "request_count"
        P50_LATENCY = "p50_latency"
        P95_LATENCY = "p95_latency"

    class ThresholdType(models.TextChoices):
        STATIC = "static"
        ANOMALY = "anomaly"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, related_name="alert_rules"
    )
    name = models.CharField(max_length=150)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    is_active = models.BooleanField(default=True)
    # Silence (evaluation continues; delivery suppressed until this passes).
    snooze_until = models.DateTimeField(null=True, blank=True)

    # Scope (all kinds).
    app_slugs = models.JSONField(default=list, blank=True)  # [] = all apps
    environment = models.CharField(max_length=64, blank=True, default="")
    filter = models.CharField(max_length=500, blank=True, default="")  # rich-filter DSL

    # Metric monitor config.
    metric = models.CharField(max_length=32, choices=Metric.choices, blank=True, default="")
    window_minutes = models.PositiveIntegerField(default=15)
    check_minutes = models.PositiveIntegerField(default=5)
    threshold_type = models.CharField(
        max_length=8, choices=ThresholdType.choices, default=ThresholdType.STATIC
    )
    comparison = models.CharField(max_length=8, blank=True, default="gt")  # gt | lt
    threshold = models.FloatField(null=True, blank=True)
    # Anomaly config: direction above|below|both, band width in robust sigmas.
    direction = models.CharField(max_length=8, blank=True, default="above")
    sensitivity = models.FloatField(default=3.0)
    min_events = models.PositiveIntegerField(default=10)  # low-traffic gate
    group_by = models.CharField(max_length=16, blank=True, default="")  # "" | consumer

    # State machine tuning (M-of-N to fire; K consecutive OK to resolve).
    for_windows = models.PositiveIntegerField(default=2)
    of_windows = models.PositiveIntegerField(default=3)
    resolve_windows = models.PositiveIntegerField(default=2)

    # Delivery.
    channels = models.ManyToManyField(AlertChannel, related_name="rules", blank=True)
    renotify_minutes = models.PositiveIntegerField(default=240)
    notify_resolved = models.BooleanField(default=True)
    # Issue rules: kick the Phase-2 investigator automatically on match.
    auto_investigate = models.BooleanField(default=False)

    last_evaluated_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "alert_rules"
        ordering = ["name"]
        indexes = [models.Index(fields=["project", "kind", "is_active"])]

    def __str__(self):
        return f"rule {self.kind}:{self.name}"


class AlertState(models.Model):
    """Evaluator state per (rule, target). target_key '' = the aggregate;
    otherwise a consumer_id (group_by=consumer fanout). recent_breaches holds
    the last `of_windows` evaluation booleans for M-of-N firing."""

    class Status(models.TextChoices):
        OK = "ok"
        PENDING = "pending"
        FIRING = "firing"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    rule = models.ForeignKey(AlertRule, on_delete=models.CASCADE, related_name="states")
    target_key = models.CharField(max_length=256, blank=True, default="")
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.OK)
    recent_breaches = models.JSONField(default=list, blank=True)  # [bool]
    ok_streak = models.PositiveIntegerField(default=0)
    last_value = models.FloatField(null=True, blank=True)
    last_threshold = models.FloatField(null=True, blank=True)
    firing_since = models.DateTimeField(null=True, blank=True)
    last_notified_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "alert_states"
        constraints = [
            models.UniqueConstraint(fields=["rule", "target_key"], name="unique_state_per_target"),
        ]

    def __str__(self):
        return f"state {self.rule_id}/{self.target_key or 'aggregate'}: {self.status}"


class AlertEvent(models.Model):
    """The alert feed: one row per notification-worthy transition (or
    renotify), with per-channel delivery outcomes."""

    class Transition(models.TextChoices):
        FIRING = "firing"
        RESOLVED = "resolved"
        RENOTIFY = "renotify"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, related_name="alert_events"
    )
    rule = models.ForeignKey(
        AlertRule, on_delete=models.SET_NULL, null=True, related_name="events"
    )
    rule_name = models.CharField(max_length=150)
    rule_kind = models.CharField(max_length=16)
    transition = models.CharField(max_length=12, choices=Transition.choices)
    # [{target, value, threshold}] — grouped: one event may carry many targets.
    targets = models.JSONField(default=list, blank=True)
    summary = models.TextField(blank=True, default="")
    fingerprint = models.CharField(max_length=40, blank=True, default="")
    # {channel_name: {ok, detail}}
    delivery = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "alert_events"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["project", "created_at"])]

    def __str__(self):
        return f"alert {self.rule_name} {self.transition}"


class AlertSignal(models.Model):
    """Outbox row written by the ingest service in the same transaction as
    the error-issue upsert (new_issue / regression). Drained by run_sentinel;
    delivery never sits on the ingest path."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project_id_raw = models.CharField(max_length=64, db_column="project_id")
    kind = models.CharField(max_length=16)  # new_issue | regression
    fingerprint = models.CharField(max_length=40)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        db_table = "alert_signals"
        ordering = ["created_at"]

    def __str__(self):
        return f"signal {self.kind} {self.fingerprint[:8]}"


class DigestSubscription(models.Model):
    """A recurring API-health digest (Phase 6 Narrator). Delivered through the
    same AlertChannels the Sentinel uses; `send_digest` sends due ones and
    stamps last_sent_at so a day's digest goes out once."""

    class Cadence(models.TextChoices):
        DAILY = "daily"
        WEEKLY = "weekly"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.OneToOneField(
        "projects.Project", on_delete=models.CASCADE, related_name="digest_subscription"
    )
    is_active = models.BooleanField(default=True)
    cadence = models.CharField(max_length=8, choices=Cadence.choices, default=Cadence.WEEKLY)
    # 0=Mon..6=Sun; used for weekly cadence.
    weekday = models.PositiveSmallIntegerField(default=0)
    channels = models.ManyToManyField(AlertChannel, related_name="digests", blank=True)
    last_sent_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "digest_subscriptions"

    def __str__(self):
        return f"digest {self.cadence} -> {self.project_id}"
