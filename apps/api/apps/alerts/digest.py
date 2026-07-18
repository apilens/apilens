"""Digest delivery (Phase 6 Narrator). Assembles a project's health rollup
(apps.ai.narrator), narrates it, and sends through the project's chosen
AlertChannels — reusing the Sentinel's notifier and retry taxonomy."""

from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

from .notify import deliver

logger = logging.getLogger(__name__)


def build_and_send(subscription, *, force: bool = False) -> dict:
    """Send one subscription's digest. Returns a delivery summary. `force`
    skips the cadence/last-sent checks (used by the 'send now' button)."""
    from apps.ai.narrator import assemble_digest, narrate_digest, render_digest_markdown

    project = subscription.project
    days = 7 if subscription.cadence == "weekly" else 1
    digest = assemble_digest(project, days=days)
    narrative = narrate_digest(digest)
    markdown = render_digest_markdown(digest)

    from django.conf import settings

    frontend = getattr(settings, "FRONTEND_URL", "").rstrip("/")
    link = f"{frontend}/projects/{project.slug}/traffic" if frontend else ""

    label = "Weekly" if days == 7 else "Daily"
    targets = [{"target": "new issues", "value": len(digest["new_issues"]), "threshold": None}]
    ctx = {
        "transition": "firing",  # notifiers key severity off this; digest is informational
        "rule_name": f"{label} digest — {project.name}",
        "rule_kind": "digest",
        "project_slug": project.slug,
        "summary": narrative,
        "targets": targets,
        "markdown": markdown,
        "link": link,
        "timestamp": timezone.now().isoformat(),
    }

    delivery: dict = {}
    for channel in subscription.channels.filter(is_active=True):
        ok, detail = deliver(channel, ctx)
        delivery[channel.name] = {"ok": ok, "detail": detail}

    subscription.last_sent_at = timezone.now()
    subscription.save(update_fields=["last_sent_at", "updated_at"])
    return {"project": project.slug, "narrative": narrative, "markdown": markdown, "delivery": delivery}


def is_due(subscription, now=None) -> bool:
    """Weekly: due on the configured weekday if not sent in the last 6 days.
    Daily: due if not sent in the last ~20 hours. (Cadence granularity is a
    day; the command is meant to run hourly or daily.)"""
    now = now or timezone.now()
    if not subscription.is_active or subscription.channels.count() == 0:
        return False
    last = subscription.last_sent_at
    if subscription.cadence == "weekly":
        if now.weekday() != subscription.weekday:
            return False
        return last is None or (now - last) >= timedelta(days=6)
    return last is None or (now - last) >= timedelta(hours=20)


def send_due(now=None) -> list[dict]:
    from .models import DigestSubscription

    now = now or timezone.now()
    results = []
    for sub in DigestSubscription.objects.filter(is_active=True).select_related("project"):
        try:
            if is_due(sub, now):
                results.append(build_and_send(sub))
        except Exception:
            logger.exception("digest for project %s failed", sub.project_id)
    return results
