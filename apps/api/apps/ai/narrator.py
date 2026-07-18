"""The Narrator (Phase 6, feature F7) — the loop narrates itself.

Three retrieval-heavy, LLM-light artifacts built from the data Phases 0-5
already produced:

  1. Postmortems — per resolved/investigated issue: timeline, blast radius,
     suspect deploy, the fix, and verification. Mostly assembly + one Agno
     synthesis pass.
  2. Digests — recurring API-health summaries (new issues, regressions,
     resolved/verified, worst endpoints, consumer movement, API-surface
     changes) delivered through the Sentinel's channels.
  3. API-surface changelog — endpoints that appeared or disappeared, straight
     from the auto-discovered `endpoints` registry (`last_seen_at`).

Every LLM call fails soft to a deterministic template — a digest or postmortem
must still render when AI is unconfigured or the model is down.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ── Postmortem ──────────────────────────────────────────────────────────────

class PostmortemDoc(BaseModel):
    title: str = Field(description="A concise incident title, e.g. 'Checkout 500s from empty coupon code'")
    summary: str = Field(description="Two-sentence executive summary: what broke, who it hit, whether it's fixed")
    markdown: str = Field(description="The full postmortem in markdown: Summary, Timeline (dated bullets), Impact (consumers/endpoints/volume), Root cause, Resolution (the fix + verification), and Follow-ups. Ground every claim in the provided evidence; never invent events, dates, or commits.")


def assemble_postmortem_facts(project, fingerprint: str) -> dict:
    """Deterministic retrieval for the postmortem synthesis."""
    from apps.integrations.models import FixHandoff
    from apps.projects.models import Deploy, ErrorIssue
    from apps.projects.services import DeployService, ErrorIssueService

    from .investigator import _clip
    from .models import Investigation

    issue = ErrorIssue.objects.filter(project=project, fingerprint=fingerprint).first()
    investigation = (
        Investigation.objects.filter(
            project=project, fingerprint=fingerprint, status=Investigation.Status.COMPLETED
        )
        .order_by("-created_at")
        .first()
    )
    verification = ErrorIssueService.get_verification(project, fingerprint)
    handoffs = list(
        FixHandoff.objects.filter(project=project, fingerprint=fingerprint)
        .select_related("repository")[:5]
    )

    deploys = []
    if issue is not None:
        deploys = DeployService.list_deploys(
            project_id=str(project.id),
            since=(issue.first_seen_at - timedelta(days=1)).isoformat(),
            until=timezone.now().isoformat(),
            limit=20,
        )

    lines: list[str] = []
    if issue is not None:
        lines.append(
            "## Issue\n"
            f"title: {issue.title}\n"
            f"exception: {issue.exception_type} on {issue.endpoint_method} {issue.endpoint_path} "
            f"→ HTTP {issue.last_status_code}\n"
            f"lifecycle: {issue.status} · occurrences≈{issue.events_count}\n"
            f"first seen: {issue.first_seen_at:%Y-%m-%d %H:%M} UTC (release {issue.first_release or '?'})\n"
            f"last seen: {issue.last_seen_at:%Y-%m-%d %H:%M} UTC (release {issue.last_release or '?'})\n"
            + (f"resolved: {issue.resolved_at:%Y-%m-%d %H:%M} UTC (release {issue.resolved_in_release or '?'})\n" if issue.resolved_at else "")
        )
    if investigation is not None:
        lines.append(
            f"## AI root cause ({investigation.confidence} confidence)\n"
            f"{investigation.root_cause}\n\n{investigation.explanation}\n"
            + (("fix plan: " + "; ".join(investigation.fix_steps)) if investigation.fix_steps else "")
        )
    if deploys:
        lines.append(
            "## Deploys around the incident\n"
            + "\n".join(
                f"- {d['deployed_at']}: {d['release']} ({d.get('commit') or '-'}) env={d['environment']}"
                for d in deploys
            )
        )
    if verification.get("exists"):
        v = verification
        lines.append(
            "## Verification\n"
            f"status: {v.get('status')} · verified_in_production: {v.get('verified')}\n"
            + (f"deploy after resolve: {v['deploy_after_resolve']['release']} at {v['deploy_after_resolve']['deployed_at']}\n" if v.get("deploy_after_resolve") else "")
            + (f"recurrences since that deploy: {v.get('events_since_deploy')}\n" if v.get("events_since_deploy") is not None else "")
        )
    if handoffs:
        lines.append(
            "## Fix handoffs\n"
            + "\n".join(
                f"- {h.kind}" + (f" → {h.external_url}" if h.external_url else "")
                + (f" ({h.repository.full_name})" if h.repository_id else "")
                for h in handoffs
            )
        )

    return {
        "issue": issue,
        "investigation": investigation,
        "verification": verification,
        "facts_text": _clip("\n\n".join(lines), 8_000) if lines else "",
    }


def generate_postmortem(project, fingerprint: str) -> dict:
    """Synthesize a postmortem. Returns
    {title, summary, markdown, model, input_tokens, output_tokens}."""
    facts = assemble_postmortem_facts(project, fingerprint)
    issue = facts["issue"]
    if issue is None:
        raise RuntimeError("No issue found for this fingerprint")
    if not facts["facts_text"]:
        raise RuntimeError("Not enough history to draft a postmortem")

    from django.conf import settings

    if not getattr(settings, "AI_API_KEY", ""):
        # Deterministic fallback: still useful, just not prose.
        md = f"# {issue.title}\n\n{facts['facts_text']}"
        return {
            "title": issue.title[:300],
            "summary": f"{issue.exception_type or 'Error'} on {issue.endpoint_method} {issue.endpoint_path}, {issue.events_count} occurrences.",
            "markdown": md,
            "model": "",
            "input_tokens": 0,
            "output_tokens": 0,
        }

    from agno.agent import Agent

    from .investigator import _build_model

    model_id, model = _build_model()
    agent = Agent(
        model=model,
        output_schema=PostmortemDoc,
        telemetry=False,
        description=(
            "You are APILens's incident scribe. Write a blameless postmortem for one "
            "production API error, using ONLY the provided evidence (issue lifecycle, AI "
            "root cause, deploys, verification, fix handoffs). Be concrete and dated; do "
            "not invent events, commits, or numbers. Keep it tight — an on-call engineer "
            "should grasp it in a minute. Sections: Summary, Timeline, Impact, Root cause, "
            "Resolution, Follow-ups."
        ),
    )
    run = agent.run(f"Draft the postmortem.\n\n{facts['facts_text']}")
    doc: PostmortemDoc = run.content

    def _tok(attr):
        try:
            return int(getattr(run.metrics, attr, 0) or 0)
        except Exception:
            return 0

    return {
        "title": (doc.title or issue.title)[:300],
        "summary": doc.summary,
        "markdown": doc.markdown,
        "model": model_id,
        "input_tokens": _tok("input_tokens"),
        "output_tokens": _tok("output_tokens"),
    }


# ── API-surface changelog ───────────────────────────────────────────────────

def api_surface_changes(project, days: int = 7) -> dict:
    """Endpoints that appeared or disappeared in the window, from the
    auto-discovered registry. `new` = first discovered inside the window;
    `gone` = active but not seen since before the window opened."""
    from apps.projects.models import App, Endpoint

    since = timezone.now() - timedelta(days=days)
    app_ids = list(App.objects.filter(project=project, is_active=True).values_list("id", flat=True))
    endpoints = Endpoint.objects.filter(app_id__in=app_ids, is_active=True).select_related("app")

    new, gone = [], []
    for ep in endpoints:
        label = {"method": ep.method, "path": ep.path, "app": ep.app.slug}
        if ep.created_at and ep.created_at >= since:
            new.append(label)
        elif ep.last_seen_at and ep.last_seen_at < since:
            gone.append(label)
    return {"new": new[:50], "gone": gone[:50]}


# ── Digest ──────────────────────────────────────────────────────────────────

def assemble_digest(project, days: int = 7) -> dict:
    """Deterministic weekly/daily rollup of a project's health."""
    from apps.projects.models import ErrorIssue
    from apps.projects.services import AnalyticsService

    now = timezone.now()
    since = now - timedelta(days=days)
    since_iso, until_iso = since.isoformat(), now.isoformat()
    prev_since_iso = (since - timedelta(days=days)).isoformat()

    summary = AnalyticsService.get_project_summary(
        project_id=str(project.id), since=since_iso, until=until_iso
    )
    prev = AnalyticsService.get_project_summary(
        project_id=str(project.id), since=prev_since_iso, until=since_iso
    )

    issues = ErrorIssue.objects.filter(project=project)
    new_issues = list(
        issues.filter(first_seen_at__gte=since).order_by("-events_count")[:10]
    )
    regressed = list(
        issues.filter(status="regressed", updated_at__gte=since).order_by("-last_seen_at")[:10]
    )
    resolved = list(
        issues.filter(status="resolved", resolved_at__gte=since).order_by("-resolved_at")[:10]
    )

    endpoints = AnalyticsService.get_project_endpoint_stats(
        project_id=str(project.id), since=since_iso, until=until_iso,
        sort_by="error_rate", sort_dir="desc", page=1, page_size=5,
    )
    worst = [e for e in (endpoints.get("items") or []) if (e.get("error_count") or 0) > 0][:5]

    slow = AnalyticsService.get_project_endpoint_stats(
        project_id=str(project.id), since=since_iso, until=until_iso,
        sort_by="p95_response_time_ms", sort_dir="desc", page=1, page_size=5,
    )
    slowest = (slow.get("items") or [])[:5]

    consumers = AnalyticsService.get_project_consumer_stats(
        project_id=str(project.id), since=since_iso, until=until_iso, limit=8
    )

    surface = api_surface_changes(project, days)

    return {
        "project_slug": project.slug,
        "project_name": project.name,
        "days": days,
        "period": {"since": since_iso, "until": until_iso},
        "summary": summary,
        "previous_summary": prev,
        "new_issues": [
            {"title": i.title, "fingerprint": i.fingerprint, "occurrences": i.events_count,
             "endpoint": f"{i.endpoint_method} {i.endpoint_path}".strip()}
            for i in new_issues
        ],
        "regressed": [{"title": i.title, "fingerprint": i.fingerprint} for i in regressed],
        "resolved": [{"title": i.title, "fingerprint": i.fingerprint} for i in resolved],
        "worst_endpoints": worst,
        "slowest_endpoints": slowest,
        "top_consumers": consumers,
        "surface": surface,
    }


def _pct_change(cur: float, prev: float) -> str:
    if not prev:
        return ""
    delta = (cur - prev) / prev * 100.0
    arrow = "▲" if delta > 0 else "▼"
    return f" ({arrow}{abs(delta):.0f}% vs prior)"


def render_digest_markdown(digest: dict) -> str:
    """Deterministic markdown (the LLM narrative rides on top of this)."""
    s = digest["summary"] or {}
    p = digest["previous_summary"] or {}
    label = "Weekly" if digest["days"] == 7 else f"{digest['days']}-day"
    lines = [f"# {label} API health — {digest['project_name']}\n"]

    total = int(s.get("total_requests") or 0)
    err_rate = float(s.get("error_rate") or 0) * 100
    p95 = float(s.get("p95_response_time_ms") or 0)
    lines.append(
        f"**{total:,} requests** · error rate **{err_rate:.2f}%**"
        f"{_pct_change(err_rate, float(p.get('error_rate') or 0) * 100)} · "
        f"p95 **{p95:.0f}ms**"
        f"{_pct_change(p95, float(p.get('p95_response_time_ms') or 0))}\n"
    )

    if digest["new_issues"]:
        lines.append("## New issues")
        lines += [f"- {i['title']} — {i['occurrences']} occ ({i['endpoint']})" for i in digest["new_issues"]]
        lines.append("")
    if digest["regressed"]:
        lines.append("## Regressed")
        lines += [f"- {i['title']}" for i in digest["regressed"]]
        lines.append("")
    if digest["resolved"]:
        lines.append("## Resolved")
        lines += [f"- {i['title']}" for i in digest["resolved"]]
        lines.append("")
    if digest["worst_endpoints"]:
        lines.append("## Highest error rate")
        lines += [
            f"- {e.get('method')} {e.get('path')} — {float(e.get('error_rate') or 0) * 100:.1f}% of {int(e.get('total_requests') or 0):,}"
            for e in digest["worst_endpoints"]
        ]
        lines.append("")
    if digest["slowest_endpoints"]:
        lines.append("## Slowest (p95)")
        lines += [
            f"- {e.get('method')} {e.get('path')} — {float(e.get('p95_response_time_ms') or 0):.0f}ms"
            for e in digest["slowest_endpoints"]
        ]
        lines.append("")
    surface = digest["surface"]
    if surface["new"] or surface["gone"]:
        lines.append("## API surface changes")
        lines += [f"- + {e['method']} {e['path']}" for e in surface["new"]]
        lines += [f"- − {e['method']} {e['path']} (no longer seen)" for e in surface["gone"]]
        lines.append("")
    return "\n".join(lines)


def narrate_digest(digest: dict) -> str:
    """One-paragraph human lead for the digest; deterministic fallback."""
    s = digest["summary"] or {}
    fallback = (
        f"{int(s.get('total_requests') or 0):,} requests this period, "
        f"{float(s.get('error_rate') or 0) * 100:.2f}% errors; "
        f"{len(digest['new_issues'])} new issues, {len(digest['resolved'])} resolved, "
        f"{len(digest['regressed'])} regressed."
    )
    try:
        from django.conf import settings

        if not getattr(settings, "AI_API_KEY", ""):
            return fallback
        from agno.agent import Agent

        from .investigator import _build_model

        _mid, model = _build_model()
        agent = Agent(
            model=model,
            telemetry=False,
            description=(
                "Write ONE short paragraph (max 4 sentences) opening an API-health digest "
                "for engineers. Lead with what changed and what needs attention; be "
                "concrete with numbers from the data; no markdown, no fluff."
            ),
        )
        run = agent.run(str({k: digest[k] for k in ("summary", "previous_summary", "new_issues", "regressed", "resolved", "worst_endpoints", "surface")})[:6000])
        text = str(run.content or "").strip()
        return text[:800] if text else fallback
    except Exception as exc:  # noqa: BLE001
        logger.warning("digest narrative failed: %s", exc)
        return fallback


# ── Postmortem runner (background thread, mirrors the investigator) ──────────

def run_postmortem(postmortem_id: str) -> None:
    from django.db import close_old_connections

    from .models import Postmortem

    close_old_connections()
    pm = Postmortem.objects.filter(id=postmortem_id).first()
    if pm is None:
        return
    pm.status = Postmortem.Status.RUNNING
    pm.save(update_fields=["status"])
    try:
        result = generate_postmortem(pm.project, pm.fingerprint)
        pm.title = result["title"]
        pm.summary = result["summary"]
        pm.markdown = result["markdown"]
        pm.model = result["model"]
        pm.input_tokens = result["input_tokens"]
        pm.output_tokens = result["output_tokens"]
        pm.status = Postmortem.Status.COMPLETED
        pm.error = ""
    except Exception as exc:  # noqa: BLE001
        logger.warning("postmortem %s failed: %s", postmortem_id, exc, exc_info=True)
        pm.status = Postmortem.Status.FAILED
        pm.error = str(exc)[:1000]
    finally:
        pm.completed_at = timezone.now()
        pm.save()
        close_old_connections()


def start_postmortem_async(postmortem_id: str) -> None:
    import threading

    threading.Thread(
        target=run_postmortem, args=(str(postmortem_id),), daemon=True,
        name=f"postmortem-{str(postmortem_id)[:8]}",
    ).start()
