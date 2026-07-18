"""Fix-brief assembly (Phase 4, feature F4).

One markdown document that hands a coding agent everything it needs to fix an
error issue without re-explaining anything: impact, root cause + fix plan
(when an investigation completed), the stack trace, suspect commits with repo
paths, a repro cURL built from the actually-captured failing request, and how
to reach the APILens MCP server for more context mid-fix. Sentry's handoff
insight, grounded in our consumer-aware data.
"""

from __future__ import annotations

import json
import logging
import shlex

logger = logging.getLogger(__name__)

_SKIP_CURL_HEADERS = {
    # Redacted or hop-by-hop values that would make the cURL misleading.
    "authorization", "cookie", "set-cookie", "host", "content-length",
    "connection", "accept-encoding", "traceparent",
}


def build_repro_curl(request: dict | None) -> str:
    """A ready-to-run cURL for the captured failing request. Redacted values
    stay `[redacted]` on purpose — the agent sees the shape, never the secret."""
    if not request:
        return ""
    method = str(request.get("method") or "GET").upper()
    base = str(request.get("base_url") or "").rstrip("/")
    path = str(request.get("raw_path") or request.get("path") or "/")
    url = f"{base}{path}" if base else path

    lines = [f"curl -X {method} {shlex.quote(url)}"]
    try:
        headers = json.loads(request.get("request_headers") or "{}")
    except (ValueError, TypeError):
        headers = {}
    if isinstance(headers, dict):
        for name, value in headers.items():
            if str(name).lower() in _SKIP_CURL_HEADERS:
                continue
            lines.append(f"-H {shlex.quote(f'{name}: {value}')}")
    body = str(request.get("request_payload") or "")
    if body and method not in ("GET", "HEAD"):
        lines.append(f"-d {shlex.quote(body[:4_000])}")
    return " \\\n  ".join(lines)


def build_fix_brief(project, fingerprint: str) -> dict:
    """Assemble the brief. Returns {title, markdown, repository, has_investigation}."""
    from apps.ai.models import Investigation
    from apps.integrations.models import CodeMapping
    from apps.projects.models import ErrorIssue

    from .investigator import assemble_evidence, _clip

    evidence = assemble_evidence(project, fingerprint)
    issue: ErrorIssue | None = evidence.get("issue")
    events = evidence.get("events") or []
    latest = events[0] if events else {}

    investigation = (
        Investigation.objects.filter(
            project=project, fingerprint=fingerprint,
            status=Investigation.Status.COMPLETED,
        )
        .order_by("-created_at")
        .first()
    )

    # The handoff repo: the issue app's first active code mapping.
    repository = None
    if issue is not None and issue.app_id:
        mapping = (
            CodeMapping.objects.filter(app_id=issue.app_id, repository__is_active=True)
            .select_related("repository")
            .first()
        )
        if mapping is not None:
            repository = mapping.repository

    title = f"Fix: {issue.title if issue else (latest.get('message') or 'API error')[:120]}"
    endpoint = (
        f"{issue.endpoint_method} {issue.endpoint_path}" if issue
        else f"{latest.get('method') or ''} {latest.get('path') or ''}"
    )

    md: list[str] = []
    md.append(f"# {title}\n")
    md.append(
        "You are fixing a production error tracked by APILens "
        f"(project `{project.slug}`, issue fingerprint `{fingerprint}`). "
        "Fix the ROOT CAUSE, not the symptom. Everything below was captured "
        "from production; sensitive values were redacted before storage.\n"
    )

    if issue is not None:
        md.append(
            "## Impact\n"
            f"- Endpoint: `{endpoint}` → HTTP {issue.last_status_code}\n"
            f"- Occurrences: ~{issue.events_count} · lifecycle: {issue.status}\n"
            f"- First seen: {issue.first_seen_at:%Y-%m-%d %H:%M} UTC"
            f" (release {issue.first_release or 'unknown'}) · "
            f"last seen: {issue.last_seen_at:%Y-%m-%d %H:%M} UTC"
            f" (release {issue.last_release or 'unknown'})\n"
        )

    if investigation is not None:
        md.append(
            "## Root cause (APILens AI investigation, "
            f"{investigation.confidence or 'low'} confidence)\n"
            f"{investigation.root_cause}\n\n{investigation.explanation}\n"
        )
        if investigation.fix_steps:
            md.append("## Suggested fix plan\n" + "\n".join(f"1. {s}" for s in investigation.fix_steps) + "\n")
        if investigation.patch_suggestion:
            md.append("## Patch sketch (verify before applying)\n```\n" + _clip(investigation.patch_suggestion, 3_000) + "\n```\n")
        if investigation.risk_notes:
            md.append(f"## Risks\n{investigation.risk_notes}\n")

    stack = str(latest.get("payload") or "")
    if stack:
        md.append("## Stack trace (latest occurrence)\n```\n" + _clip(stack, 6_000) + "\n```\n")

    suspects = evidence.get("suspects") or {}
    commits = suspects.get("suspect_commits") or []
    if commits:
        lines = [
            f"- `{c.get('short_sha')}` {c.get('message')} — {c.get('author_login') or c.get('author_name')}"
            f" ({c.get('date')}) touching {', '.join(c.get('files') or [])}"
            for c in commits
        ]
        md.append("## Suspect commits (scoped to the commit that was running)\n" + "\n".join(lines) + "\n")
    frames = suspects.get("frame_links") or []
    if frames:
        lines = [f"- `{f['mapped_path']}:{f['line']}` in `{f['function']}` ({f['repository']})" for f in frames[:6]]
        md.append("## In-app frames (repo paths via code mappings)\n" + "\n".join(lines) + "\n")

    curl = build_repro_curl(evidence.get("request"))
    if curl:
        md.append("## Reproduce (captured failing request)\n```bash\n" + curl + "\n```\n")

    deploy_release = str(latest.get("release") or "")
    md.append(
        "## Definition of done\n"
        f"- The endpoint `{endpoint}` no longer produces this error for the repro request.\n"
        "- Add or update a test that fails before the fix and passes after.\n"
        "- Open a PR; reference this issue fingerprint in the description: "
        f"`apilens:{fingerprint}`.\n"
        + (f"- The bug shipped in release `{deploy_release}` — verify your fix against that code.\n" if deploy_release else "")
        + "- After the fix deploys, APILens watches this fingerprint and marks the issue "
        "*verified in production* only when it stops recurring.\n"
    )
    md.append(
        "## More context (APILens MCP)\n"
        "This project exposes its telemetry over MCP. If configured, query "
        "`get_error_events`, `get_trace`, `search_requests`, or `get_investigation` "
        f"with fingerprint `{fingerprint}` for anything missing here.\n"
    )

    return {
        "title": title,
        "markdown": "\n".join(md),
        "fingerprint": fingerprint,
        "repository": repository.full_name if repository is not None else "",
        "repository_id": str(repository.id) if repository is not None else "",
        "has_investigation": investigation is not None,
    }
