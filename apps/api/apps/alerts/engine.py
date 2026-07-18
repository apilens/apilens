"""Sentinel evaluation engine (see PHASE5_SENTINEL_DESIGN.md).

Pure-math pieces (baseline, band, state stepping) are module functions so
they unit-test without a database; the orchestration (evaluate_rule,
drain_signals) wires them to ClickHouse windows, Postgres state, and the
notifiers.
"""

from __future__ import annotations

import logging
import statistics
from datetime import datetime, timedelta, timezone as tz

from django.utils import timezone

from .models import AlertEvent, AlertRule, AlertSignal, AlertState
from .notify import deliver

logger = logging.getLogger(__name__)

# Anomaly guards (research-grounded: Watchdog's traffic gate, Datadog's
# cold-start rule, deploy-time noise).
MIN_HISTORY_WINDOWS = 4
DEPLOY_GRACE_MINUTES = 15
HISTORY_TRAILING = 6  # immediately-trailing windows
_MAD_CLEAN_Z = 3.0

# Metric floors: minimum band half-width so flat history can't produce a
# hair-trigger band (rates in fraction points, latency/count relative).
_RATE_FLOOR = 0.02
_LATENCY_FLOOR_FRAC = 0.15
_COUNT_FLOOR_FRAC = 0.30

RATE_METRICS = {"error_rate", "server_error_rate", "client_error_rate"}
LATENCY_METRICS = {"p50_latency", "p95_latency"}


# ── Robust-stats baseline (pure) ────────────────────────────────────────────

def mad(values: list[float]) -> float:
    """Median absolute deviation, scaled to be σ-comparable (×1.4826)."""
    if not values:
        return 0.0
    med = statistics.median(values)
    return 1.4826 * statistics.median([abs(v - med) for v in values])


def clean_history(values: list[float]) -> list[float]:
    """Drop past-incident contamination: values with MAD-z > 3 (the
    Booking.com history-cleaning step). Falls back to the raw list when the
    spread is zero."""
    if len(values) < 3:
        return list(values)
    med = statistics.median(values)
    spread = mad(values)
    if spread <= 0:
        return list(values)
    return [v for v in values if abs(v - med) / spread <= _MAD_CLEAN_Z] or list(values)


def anomaly_band(history: list[float], metric: str, sensitivity: float) -> tuple[float, float, float] | None:
    """(baseline, low, high) or None when history is too thin (cold start)."""
    cleaned = clean_history(history)
    if len(cleaned) < MIN_HISTORY_WINDOWS:
        return None
    baseline = statistics.median(cleaned)
    spread = mad(cleaned)
    if metric in RATE_METRICS:
        floor = _RATE_FLOOR
    elif metric in LATENCY_METRICS:
        floor = abs(baseline) * _LATENCY_FLOOR_FRAC
    else:
        floor = abs(baseline) * _COUNT_FLOOR_FRAC
    half = max(1.0, float(sensitivity)) * max(spread, floor)
    return baseline, baseline - half, baseline + half


def is_breach_static(value: float, comparison: str, threshold: float) -> bool:
    return value < threshold if comparison == "lt" else value > threshold


def is_breach_anomaly(value: float, band: tuple[float, float, float], direction: str) -> bool:
    _baseline, low, high = band
    if direction == "below":
        return value < low
    if direction == "both":
        return value < low or value > high
    return value > high


# ── State machine (pure): M-of-N to fire, K consecutive OK to resolve ───────

def step_state(
    status: str,
    recent: list[bool],
    ok_streak: int,
    breached: bool,
    *,
    for_windows: int,
    of_windows: int,
    resolve_windows: int,
) -> tuple[str, list[bool], int, str]:
    """Returns (new_status, new_recent, new_ok_streak, transition) where
    transition ∈ '', 'firing', 'resolved'. M-of-N instead of a strict
    consecutive duration so a momentary dip can't reset a real incident
    (the Google SRE for-duration caveat)."""
    recent = (list(recent) + [bool(breached)])[-max(1, of_windows):]
    breaches = sum(1 for b in recent if b)

    if status == "firing":
        if breached:
            return "firing", recent, 0, ""
        ok_streak += 1
        if ok_streak >= max(1, resolve_windows):
            return "ok", [], 0, "resolved"
        return "firing", recent, ok_streak, ""

    # ok / pending
    if breaches >= max(1, for_windows):
        return "firing", recent, 0, "firing"
    if breached:
        return "pending", recent, 0, ""
    return "ok", recent, 0, ""


# ── ClickHouse window queries ───────────────────────────────────────────────

_METRIC_EXPR = {
    "request_count": "toFloat64(count())",
    "error_rate": "if(count() = 0, 0, countIf(status_code >= 400) / count())",
    "server_error_rate": "if(count() = 0, 0, countIf(status_code >= 500) / count())",
    "client_error_rate": "if(count() = 0, 0, countIf(status_code >= 400 AND status_code < 500) / count())",
    "p50_latency": "quantile(0.5)(response_time_ms)",
    "p95_latency": "quantile(0.95)(response_time_ms)",
}


def _scope_where(rule: AlertRule, params: dict) -> str:
    from apps.projects.models import App
    from apps.projects.services import AnalyticsService

    where = "WHERE project_id = %(project_id)s"
    params["project_id"] = str(rule.project_id)
    if rule.app_slugs:
        ids = [
            str(i)
            for i in App.objects.filter(
                project_id=rule.project_id, slug__in=rule.app_slugs
            ).values_list("id", flat=True)
        ]
        params["scope_app_ids"] = ids or ["__none__"]
        where += " AND app_id IN %(scope_app_ids)s"
    if rule.environment:
        params["scope_env"] = rule.environment
        where += " AND environment = %(scope_env)s"
    if rule.filter:
        try:
            where += " " + AnalyticsService.build_filter_clause(
                str(rule.project_id), rule.filter, params, key_prefix="aflt"
            )
        except Exception as exc:
            logger.warning("rule %s filter invalid, ignoring: %s", rule.id, exc)
    return where


def query_window(client, rule: AlertRule, start: datetime, end: datetime) -> tuple[float, int]:
    """(metric value, event count) for one aggregate window."""
    params: dict = {"since": start, "until": end}
    where = _scope_where(rule, params)
    expr = _METRIC_EXPR[rule.metric]
    rows = client.execute(
        f"""
        SELECT {expr} AS value, count() AS events
        FROM api_requests
        {where}
          AND timestamp >= %(since)s AND timestamp < %(until)s
        """,
        params,
    )
    if not rows:
        return 0.0, 0
    row = rows[0]
    return float(row.get("value") or 0.0), int(row.get("events") or 0)


def query_window_by_consumer(client, rule: AlertRule, start: datetime, end: datetime, limit: int = 50) -> list[dict]:
    params: dict = {"since": start, "until": end, "limit": limit, "min_events": max(1, rule.min_events)}
    where = _scope_where(rule, params)
    expr = _METRIC_EXPR[rule.metric]
    return client.execute(
        f"""
        SELECT consumer_id AS target, {expr} AS value, count() AS events
        FROM api_requests
        {where}
          AND timestamp >= %(since)s AND timestamp < %(until)s
          AND consumer_id != ''
        GROUP BY consumer_id
        HAVING events >= %(min_events)s
        ORDER BY events DESC
        LIMIT %(limit)s
        """,
        params,
    )


def collect_history(client, rule: AlertRule, now: datetime) -> list[float]:
    """Baseline sample: 6 trailing windows + same window −24h ±1 + −7d ±1
    (seasonal-naive offsets). Windows with fewer than min_events are skipped
    so quiet nights don't drag the baseline to zero."""
    w = timedelta(minutes=rule.window_minutes)
    offsets: list[datetime] = [now - w * (i + 1) for i in range(HISTORY_TRAILING)]
    for anchor in (now - timedelta(hours=24), now - timedelta(days=7)):
        offsets += [anchor - w, anchor, anchor + w]
    values: list[float] = []
    for end in offsets:
        try:
            value, events = query_window(client, rule, end - w, end)
        except Exception as exc:
            logger.warning("history window query failed: %s", exc)
            continue
        if events >= rule.min_events:
            values.append(value)
    return values


# ── Deploy grace ────────────────────────────────────────────────────────────

def in_deploy_grace(rule: AlertRule, now: datetime) -> bool:
    from apps.projects.models import Deploy

    qs = Deploy.objects.filter(
        project_id=rule.project_id,
        deployed_at__gte=now - timedelta(minutes=DEPLOY_GRACE_MINUTES),
    )
    if rule.environment:
        qs = qs.filter(environment=rule.environment)
    return qs.exists()


# ── Notification orchestration ──────────────────────────────────────────────

def _ai_triage_line(rule: AlertRule, targets: list[dict], transition: str) -> str:
    """One impact-first sentence via Agno when AI is configured; templated
    fallback otherwise. Never raises."""
    fallback = ""
    try:
        first = targets[0] if targets else {}
        fallback = (
            f"{rule.get_kind_display() if hasattr(rule, 'get_kind_display') else rule.kind} "
            f"'{rule.name}' is {transition}"
            + (f" (value {round(float(first.get('value')), 4)})" if first.get("value") is not None else "")
        )
    except Exception:
        fallback = f"{rule.name} is {transition}"
    try:
        from apps.ai.llm import ai_enabled, build_model

        if not ai_enabled():
            return fallback
        from agno.agent import Agent

        _mid, model = build_model()
        agent = Agent(
            model=model,
            telemetry=False,
            description=(
                "Write ONE short sentence (max 30 words) for an engineer's alert "
                "notification. Lead with impact (who/what is affected), be concrete, "
                "no fluff, no markdown."
            ),
        )
        run = agent.run(
            f"Alert rule: {rule.name} (kind={rule.kind}, metric={rule.metric or '-'}, "
            f"scope env={rule.environment or 'all'}). Transition: {transition}. "
            f"Targets: {targets[:5]}"
        )
        text = str(run.content or "").strip()
        return text[:300] if text else fallback
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI triage line failed: %s", exc)
        return fallback


def emit(rule: AlertRule, transition: str, targets: list[dict], *, fingerprint: str = "") -> AlertEvent:
    """Create the AlertEvent and deliver to the rule's channels (grouped: one
    notification per rule per tick regardless of target count)."""
    from django.conf import settings

    now = timezone.now()
    snoozed = bool(rule.snooze_until and rule.snooze_until > now)
    summary = _ai_triage_line(rule, targets, transition)
    frontend = getattr(settings, "FRONTEND_URL", "").rstrip("/")
    link = f"{frontend}/projects/{rule.project.slug}/errors" if frontend else ""

    ctx = {
        "transition": transition,
        "rule_name": rule.name,
        "rule_kind": rule.kind,
        "project_slug": rule.project.slug,
        "summary": summary,
        "targets": targets,
        "fingerprint": fingerprint,
        "link": link,
        "timestamp": now.isoformat(),
    }
    delivery: dict = {}
    if snoozed:
        delivery["_snoozed"] = {"ok": False, "detail": f"snoozed until {rule.snooze_until.isoformat()}"}
    else:
        for channel in rule.channels.filter(is_active=True):
            ok, detail = deliver(channel, ctx)
            delivery[channel.name] = {"ok": ok, "detail": detail}

    return AlertEvent.objects.create(
        project=rule.project,
        rule=rule,
        rule_name=rule.name,
        rule_kind=rule.kind,
        transition=transition,
        targets=targets,
        summary=summary,
        fingerprint=fingerprint,
        delivery=delivery,
    )


# ── Metric rule evaluation ──────────────────────────────────────────────────

def evaluate_metric_rule(rule: AlertRule, now: datetime | None = None) -> list[AlertEvent]:
    from core.database.clickhouse.client import get_clickhouse_client

    now = now or datetime.now(tz=tz.utc)
    events: list[AlertEvent] = []
    try:
        client = get_clickhouse_client()
    except Exception as exc:
        logger.warning("ClickHouse unavailable; skipping rule %s: %s", rule.id, exc)
        return events

    window_start = now - timedelta(minutes=rule.window_minutes)

    # Targets to evaluate this tick: {target_key: (value, events)}.
    measured: dict[str, tuple[float, int]] = {}
    if rule.group_by == "consumer":
        try:
            for row in query_window_by_consumer(client, rule, window_start, now):
                measured[str(row["target"])[:256]] = (float(row["value"] or 0.0), int(row["events"] or 0))
        except Exception as exc:
            logger.warning("consumer window query failed for rule %s: %s", rule.id, exc)
            return events
    else:
        try:
            value, count = query_window(client, rule, window_start, now)
        except Exception as exc:
            logger.warning("window query failed for rule %s: %s", rule.id, exc)
            return events
        measured[""] = (value, count)

    # Threshold per target.
    band = None
    if rule.threshold_type == AlertRule.ThresholdType.ANOMALY:
        if in_deploy_grace(rule, now):
            logger.info("rule %s in deploy grace; skipping anomaly evaluation", rule.id)
            return events
        history = collect_history(client, rule, now)
        band = anomaly_band(history, rule.metric, rule.sensitivity)
        if band is None:
            return events  # cold start — not enough usable history yet

    firing_targets: list[dict] = []
    resolved_targets: list[dict] = []
    renotify_targets: list[dict] = []

    # Include currently-firing targets that vanished from this tick's window
    # (e.g. consumer stopped sending) — they step with breached=False.
    known = {
        s.target_key: s
        for s in AlertState.objects.filter(rule=rule)
    }
    all_keys = set(measured) | {k for k, s in known.items() if s.status != "ok"}

    for key in all_keys:
        value, count = measured.get(key, (0.0, 0))
        if key in measured and count < rule.min_events and rule.group_by != "consumer":
            # Low-traffic gate for the aggregate: skip the whole evaluation.
            continue

        if rule.threshold_type == AlertRule.ThresholdType.ANOMALY:
            breached = key in measured and is_breach_anomaly(value, band, rule.direction or "above")
            threshold_repr = band[2] if (rule.direction or "above") != "below" else band[1]
        else:
            breached = key in measured and is_breach_static(value, rule.comparison or "gt", float(rule.threshold or 0.0))
            threshold_repr = float(rule.threshold or 0.0)

        state = known.get(key) or AlertState(rule=rule, target_key=key)
        new_status, new_recent, new_streak, transition = step_state(
            state.status, state.recent_breaches or [], state.ok_streak, breached,
            for_windows=rule.for_windows, of_windows=rule.of_windows,
            resolve_windows=rule.resolve_windows,
        )
        state.status = new_status
        state.recent_breaches = new_recent
        state.ok_streak = new_streak
        state.last_value = round(value, 6)
        state.last_threshold = round(float(threshold_repr), 6)

        target_info = {"target": key, "value": round(value, 4), "threshold": round(float(threshold_repr), 4)}
        if transition == "firing":
            state.firing_since = now
            state.last_notified_at = now
            firing_targets.append(target_info)
        elif transition == "resolved":
            state.firing_since = None
            resolved_targets.append(target_info)
        elif state.status == "firing" and state.last_notified_at is not None:
            if now - state.last_notified_at >= timedelta(minutes=max(5, rule.renotify_minutes)):
                state.last_notified_at = now
                renotify_targets.append(target_info)
        state.save()

    if firing_targets:
        events.append(emit(rule, "firing", firing_targets))
    if renotify_targets:
        events.append(emit(rule, "renotify", renotify_targets))
    if resolved_targets and rule.notify_resolved:
        events.append(emit(rule, "resolved", resolved_targets))

    rule.last_evaluated_at = timezone.now()
    rule.save(update_fields=["last_evaluated_at"])
    return events


# ── Signal (issue-rule) processing ──────────────────────────────────────────

def drain_signals(batch: int = 200) -> int:
    """Deliver queued new_issue/regression signals to matching issue rules."""
    from apps.projects.models import App

    now = timezone.now()
    signals = list(AlertSignal.objects.filter(processed_at__isnull=True)[:batch])
    processed = 0
    for signal in signals:
        try:
            rules = AlertRule.objects.filter(
                project_id=signal.project_id_raw,
                kind=signal.kind,
                is_active=True,
            ).prefetch_related("channels")
            payload = signal.payload or {}
            for rule in rules:
                if rule.environment and payload.get("environment") and payload["environment"] != rule.environment:
                    continue
                if rule.app_slugs:
                    app_id = str(payload.get("app_id") or "")
                    slugs = set(
                        App.objects.filter(id__in=[app_id]).values_list("slug", flat=True)
                    ) if app_id else set()
                    if not (slugs & set(rule.app_slugs)):
                        continue
                target = {
                    "target": payload.get("title") or signal.fingerprint[:12],
                    "value": None,
                    "threshold": None,
                    "endpoint": f"{payload.get('endpoint_method', '')} {payload.get('endpoint_path', '')}".strip(),
                }
                emit(rule, "firing", [target], fingerprint=signal.fingerprint)
                if rule.auto_investigate:
                    try:
                        from apps.ai.services import InvestigationService
                        from apps.projects.models import Project

                        project = Project.objects.filter(id=signal.project_id_raw).first()
                        if project is not None:
                            InvestigationService.start(project, signal.fingerprint, user=None)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("auto-investigate failed for %s: %s", signal.fingerprint, exc)
        except Exception:
            logger.exception("signal %s processing failed", signal.id)
        finally:
            signal.processed_at = now
            signal.save(update_fields=["processed_at"])
            processed += 1
    return processed


def run_tick() -> dict:
    """One evaluator tick: drain the outbox, evaluate due metric rules."""
    from django.db import close_old_connections

    close_old_connections()
    drained = drain_signals()
    evaluated = 0
    fired = 0
    now = timezone.now()
    due = AlertRule.objects.filter(kind=AlertRule.Kind.METRIC, is_active=True)
    for rule in due.select_related("project").prefetch_related("channels"):
        if rule.last_evaluated_at and now - rule.last_evaluated_at < timedelta(
            minutes=max(1, rule.check_minutes)
        ):
            continue
        evaluated += 1
        try:
            fired += len(evaluate_metric_rule(rule))
        except Exception:
            logger.exception("metric rule %s evaluation failed", rule.id)
    close_old_connections()
    return {"signals": drained, "rules_evaluated": evaluated, "notifications": fired}
