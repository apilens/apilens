"""Notification delivery: Slack webhook, generic webhook, email.

Retry taxonomy per the Phase-5 research: retry ONLY 5xx / timeouts / 429
(honoring Retry-After), 3 attempts with exponential backoff + full jitter;
all other 4xx fail fast (Slack's invalid_payload/action_prohibited class must
not be retried). Every channel returns {ok, detail} for the AlertEvent
delivery record — a failed channel never raises into the evaluator.
"""

from __future__ import annotations

import logging
import random
import time

import httpx

logger = logging.getLogger(__name__)

_MAX_ATTEMPTS = 3
_BACKOFF_BASE_SECONDS = 0.5
_BACKOFF_MAX_SECONDS = 8.0
_TIMEOUT_SECONDS = 8.0

# Generic webhook payload version (Alertmanager-inspired envelope).
WEBHOOK_PAYLOAD_VERSION = "1"


def _post_with_retry(url: str, json_body: dict) -> tuple[bool, str]:
    last_detail = "unknown"
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = httpx.post(url, json=json_body, timeout=_TIMEOUT_SECONDS)
        except httpx.HTTPError as exc:
            last_detail = f"network error: {exc.__class__.__name__}"
        else:
            if resp.status_code < 300:
                return True, f"http {resp.status_code}"
            last_detail = f"http {resp.status_code}: {resp.text[:120]}"
            if resp.status_code != 429 and resp.status_code < 500:
                # Non-retriable 4xx (bad payload, revoked webhook, …).
                return False, last_detail
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After", "")
                try:
                    time.sleep(min(float(retry_after), _BACKOFF_MAX_SECONDS))
                    continue
                except (TypeError, ValueError):
                    pass
        if attempt < _MAX_ATTEMPTS - 1:
            exp = min(_BACKOFF_BASE_SECONDS * (2 ** attempt), _BACKOFF_MAX_SECONDS)
            time.sleep(random.uniform(0, exp))  # full jitter
    return False, last_detail


def _severity_emoji(transition: str) -> str:
    return {"firing": "🔴", "renotify": "🔁", "resolved": "✅"}.get(transition, "🔔")


def send_slack(url: str, ctx: dict) -> tuple[bool, str]:
    """Slack incoming webhook: `text` is required (its absence errors), Block
    Kit body for structure."""
    emoji = _severity_emoji(ctx["transition"])
    headline = f"{emoji} {ctx['rule_name']} — {ctx['transition'].upper()}"
    lines = [ctx.get("summary") or ""]
    for t in ctx.get("targets", [])[:8]:
        label = t.get("target") or "aggregate"
        value = t.get("value")
        threshold = t.get("threshold")
        detail = f"• *{label}*"
        if value is not None:
            detail += f": {value}"
        if threshold is not None:
            detail += f" (threshold {threshold})"
        lines.append(detail)
    # Digests carry a long markdown body; prefer it over the target list.
    if ctx.get("markdown"):
        lines = [ctx.get("summary") or "", "", str(ctx["markdown"])]
    if ctx.get("link"):
        lines.append(f"<{ctx['link']}|Open in APILens>")
    body = {
        "text": headline,
        "blocks": [
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*{headline}*"}},
            {"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(x for x in lines if x)[:2900]}},
        ],
    }
    return _post_with_retry(url, body)


def send_webhook(url: str, ctx: dict) -> tuple[bool, str]:
    payload = {
        "version": WEBHOOK_PAYLOAD_VERSION,
        "status": "resolved" if ctx["transition"] == "resolved" else "firing",
        "transition": ctx["transition"],
        "project": ctx.get("project_slug", ""),
        "rule": {"name": ctx["rule_name"], "kind": ctx.get("rule_kind", "")},
        "summary": ctx.get("summary", ""),
        "targets": ctx.get("targets", []),
        "fingerprint": ctx.get("fingerprint", ""),
        "link": ctx.get("link", ""),
        "timestamp": ctx.get("timestamp", ""),
    }
    if ctx.get("markdown"):
        payload["markdown"] = str(ctx["markdown"])
    return _post_with_retry(url, payload)


def send_email(emails: list[str], ctx: dict) -> tuple[bool, str]:
    from django.conf import settings
    from django.core.mail import send_mail

    recipients = [e.strip() for e in emails if e and "@" in str(e)][:10]
    if not recipients:
        return False, "no valid recipients"
    emoji = _severity_emoji(ctx["transition"])
    subject = f"{emoji} [APILens] {ctx['rule_name']} {ctx['transition']}"
    lines = [ctx.get("summary") or "", ""]
    if ctx.get("markdown"):
        lines.append(str(ctx["markdown"]))
    else:
        for t in ctx.get("targets", [])[:10]:
            lines.append(
                f"- {t.get('target') or 'aggregate'}: value={t.get('value')} threshold={t.get('threshold')}"
            )
    if ctx.get("link"):
        lines += ["", f"Open in APILens: {ctx['link']}"]
    try:
        send_mail(
            subject,
            "\n".join(lines),
            getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@apilens.ai"),
            recipients,
            fail_silently=False,
        )
        return True, f"sent to {len(recipients)}"
    except Exception as exc:  # noqa: BLE001 — recorded, never raised
        return False, f"email error: {exc}"


def deliver(channel, ctx: dict) -> tuple[bool, str]:
    """Dispatch one channel; exceptions become a failed delivery record."""
    try:
        config = channel.config or {}
        if channel.kind == "slack_webhook":
            url = str(config.get("url") or "")
            return send_slack(url, ctx) if url else (False, "missing url")
        if channel.kind == "webhook":
            url = str(config.get("url") or "")
            return send_webhook(url, ctx) if url else (False, "missing url")
        if channel.kind == "email":
            return send_email(list(config.get("emails") or []), ctx)
        return False, f"unknown channel kind {channel.kind}"
    except Exception as exc:  # noqa: BLE001
        logger.warning("delivery via %s failed: %s", channel.kind, exc, exc_info=True)
        return False, f"error: {exc}"
