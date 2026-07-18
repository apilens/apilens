"""Alert channel/rule CRUD + serialization for the settings UI."""

from __future__ import annotations

from core.exceptions.base import NotFoundError, ValidationError

from .models import AlertChannel, AlertEvent, AlertRule


def serialize_channel(c: AlertChannel) -> dict:
    return {
        "id": str(c.id),
        "kind": c.kind,
        "name": c.name,
        "config": c.config or {},
        "is_active": c.is_active,
    }


def serialize_rule(r: AlertRule) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "kind": r.kind,
        "is_active": r.is_active,
        "snooze_until": r.snooze_until.isoformat() if r.snooze_until else None,
        "app_slugs": r.app_slugs or [],
        "environment": r.environment,
        "filter": r.filter,
        "metric": r.metric,
        "window_minutes": r.window_minutes,
        "check_minutes": r.check_minutes,
        "threshold_type": r.threshold_type,
        "comparison": r.comparison,
        "threshold": r.threshold,
        "direction": r.direction,
        "sensitivity": r.sensitivity,
        "min_events": r.min_events,
        "group_by": r.group_by,
        "for_windows": r.for_windows,
        "of_windows": r.of_windows,
        "resolve_windows": r.resolve_windows,
        "renotify_minutes": r.renotify_minutes,
        "notify_resolved": r.notify_resolved,
        "auto_investigate": r.auto_investigate,
        "channel_ids": [str(c.id) for c in r.channels.all()],
        "last_evaluated_at": r.last_evaluated_at.isoformat() if r.last_evaluated_at else None,
    }


def serialize_event(e: AlertEvent) -> dict:
    return {
        "id": str(e.id),
        "rule_name": e.rule_name,
        "rule_kind": e.rule_kind,
        "transition": e.transition,
        "targets": e.targets or [],
        "summary": e.summary,
        "fingerprint": e.fingerprint,
        "delivery": e.delivery or {},
        "created_at": e.created_at.isoformat(),
    }


class AlertService:
    @staticmethod
    def create_channel(project, user, data: dict) -> AlertChannel:
        kind = str(data.get("kind") or "").strip()
        if kind not in AlertChannel.Kind.values:
            raise ValidationError(f"kind must be one of {list(AlertChannel.Kind.values)}")
        name = str(data.get("name") or "").strip()[:100]
        if not name:
            raise ValidationError("name is required")
        config = data.get("config") or {}
        if kind in ("slack_webhook", "webhook"):
            url = str(config.get("url") or "").strip()
            if not url.startswith("https://"):
                raise ValidationError("config.url must be an https URL")
            config = {"url": url}
        elif kind == "email":
            emails = [str(e).strip() for e in (config.get("emails") or []) if "@" in str(e)]
            if not emails:
                raise ValidationError("config.emails must contain at least one address")
            config = {"emails": emails[:10]}
        return AlertChannel.objects.create(
            project=project, kind=kind, name=name, config=config, created_by=user
        )

    @staticmethod
    def delete_channel(project, channel_id: str) -> None:
        deleted, _ = AlertChannel.objects.filter(project=project, id=channel_id).delete()
        if not deleted:
            raise NotFoundError("Channel not found")

    @staticmethod
    def upsert_rule(project, user, data: dict, rule: AlertRule | None = None) -> AlertRule:
        kind = str(data.get("kind") or (rule.kind if rule else "")).strip()
        if kind not in AlertRule.Kind.values:
            raise ValidationError(f"kind must be one of {list(AlertRule.Kind.values)}")
        name = str(data.get("name") or (rule.name if rule else "")).strip()[:150]
        if not name:
            raise ValidationError("name is required")

        if rule is None:
            rule = AlertRule(project=project, created_by=user)
        rule.name = name
        rule.kind = kind
        rule.is_active = bool(data.get("is_active", rule.is_active if rule.pk else True))
        rule.app_slugs = [str(s) for s in (data.get("app_slugs") or [])][:20]
        rule.environment = str(data.get("environment") or "").strip().lower()[:64]
        rule.filter = str(data.get("filter") or "").strip()[:500]
        if rule.filter:
            from apps.projects.filters import parse_filter

            parse_filter(rule.filter)  # 422 on an invalid DSL string

        if kind == AlertRule.Kind.METRIC:
            metric = str(data.get("metric") or rule.metric or "").strip()
            if metric not in AlertRule.Metric.values:
                raise ValidationError(f"metric must be one of {list(AlertRule.Metric.values)}")
            rule.metric = metric
            rule.window_minutes = max(5, min(int(data.get("window_minutes") or rule.window_minutes or 15), 240))
            rule.check_minutes = max(1, min(int(data.get("check_minutes") or rule.check_minutes or 5), 60))
            threshold_type = str(data.get("threshold_type") or rule.threshold_type or "static")
            if threshold_type not in AlertRule.ThresholdType.values:
                raise ValidationError("threshold_type must be static or anomaly")
            rule.threshold_type = threshold_type
            if threshold_type == AlertRule.ThresholdType.STATIC:
                if data.get("threshold") is None and rule.threshold is None:
                    raise ValidationError("threshold is required for static rules")
                if data.get("threshold") is not None:
                    rule.threshold = float(data["threshold"])
                rule.comparison = "lt" if str(data.get("comparison") or rule.comparison) == "lt" else "gt"
            else:
                rule.direction = str(data.get("direction") or rule.direction or "above")
                if rule.direction not in ("above", "below", "both"):
                    raise ValidationError("direction must be above, below, or both")
                rule.sensitivity = max(1.0, min(float(data.get("sensitivity") or rule.sensitivity or 3.0), 10.0))
            rule.min_events = max(1, min(int(data.get("min_events") or rule.min_events or 10), 100000))
            group_by = str(data.get("group_by") if data.get("group_by") is not None else rule.group_by or "")
            if group_by not in ("", "consumer"):
                raise ValidationError("group_by must be empty or 'consumer'")
            if group_by == "consumer" and rule.threshold_type != AlertRule.ThresholdType.STATIC:
                raise ValidationError("group_by=consumer supports static thresholds only (v1)")
            rule.group_by = group_by

        # State-machine tuning (M-of-N to fire; K consecutive OK to resolve).
        # Clamped and kept internally consistent (for ≤ of).
        rule.of_windows = max(1, min(int(data.get("of_windows") or rule.of_windows or 3), 10))
        rule.for_windows = max(1, min(int(data.get("for_windows") or rule.for_windows or 2), rule.of_windows))
        rule.resolve_windows = max(1, min(int(data.get("resolve_windows") or rule.resolve_windows or 2), 10))

        rule.renotify_minutes = max(5, min(int(data.get("renotify_minutes") or rule.renotify_minutes or 240), 10080))
        rule.notify_resolved = bool(data.get("notify_resolved", rule.notify_resolved))
        rule.auto_investigate = bool(data.get("auto_investigate", rule.auto_investigate))
        rule.save()

        if data.get("channel_ids") is not None:
            channels = AlertChannel.objects.filter(
                project=project, id__in=[str(c) for c in data["channel_ids"]]
            )
            rule.channels.set(channels)
        return rule

    @staticmethod
    def delete_rule(project, rule_id: str) -> None:
        deleted, _ = AlertRule.objects.filter(project=project, id=rule_id).delete()
        if not deleted:
            raise NotFoundError("Rule not found")
