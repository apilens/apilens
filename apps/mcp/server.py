"""APILens MCP server (Phase 3 of the AI-native plan, feature F6).

Exposes a project's telemetry to coding agents (Claude Code, Cursor, Copilot,
claude.ai) over the Model Context Protocol — the Sentry-validated pattern:
an observability product's MCP server makes every agent a client for free,
and it is how Phase 4's fix agents will pull context mid-fix.

Architecture: a standalone Starlette/uvicorn service (prod: mcp.apilens.ai)
that BOOTSTRAPS DJANGO IN-PROCESS from apps/api, so every tool reuses the
exact analytics services the dashboard uses — no query duplication, unlike
the hand-ported ingest service. Tools are sync functions (FastMCP runs them
on a worker thread, where the Django ORM is at home).

Auth: the project-level API key (same key the SDK uses), via
`Authorization: Bearer <key>` or `X-API-Key`. Every request resolves the key
to ONE project and all tools are scoped to it — an agent can never see
another project's data. Stateless HTTP transport, so any client (or several)
can connect without session affinity.

Run locally:
    cd apps/api && ../../apps/mcp/run.sh          # http://localhost:8300/mcp

Client config (Claude Code):
    claude mcp add --transport http apilens http://localhost:8300/mcp \
        --header "X-API-Key: <project api key>"
"""

from __future__ import annotations

import contextvars
import hashlib
import os
import sys
from pathlib import Path

# ── Django bootstrap (before any Django import) ─────────────────────────────
_API_DIR = Path(__file__).resolve().parent.parent / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402

django.setup()

from django.db import close_old_connections  # noqa: E402

from mcp.server.fastmcp import FastMCP  # noqa: E402

# (project_id, project_slug) for the authenticated request; set by the ASGI
# auth middleware, read by every tool. Contextvars propagate into the worker
# thread FastMCP runs sync tools on.
_project_ctx: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "apilens_mcp_project", default=None
)

FILTER_GRAMMAR = (
    "Filter strings are `field:op:value` clauses joined by `;` (AND). "
    "Comma-separates OR values within a clause; a leading `-` negates. Fields: "
    "app (slug; is/not), method (is/not), status (int; is/not/gt/gte/lt/lte/between), "
    "status_class (1xx..5xx; is/not), path (is/not/contains/startswith/endswith), "
    "latency (ms; comparisons), env (is/not), consumer (is/not/contains), "
    "req_size, resp_size (bytes; comparisons), ip (is/not/contains), ua (contains), "
    "release (is/not/contains). Example: "
    "`status_class:is:5xx;path:startswith:/charge;release:is:v1.4.2`."
)

mcp_server = FastMCP(
    name="apilens",
    stateless_http=True,
    instructions=(
        "APILens API-observability telemetry for ONE project (scoped by the API key). "
        "Typical flows: get_project_overview → list_error_issues → get_error_events / "
        "suspect_commits / start_investigation for debugging; search_requests with a "
        f"filter string for traffic questions. {FILTER_GRAMMAR} "
        "Timestamps are ISO8601 UTC; since/until default to the last 24h."
    ),
)


def _project() -> tuple[str, str]:
    ctx = _project_ctx.get()
    if ctx is None:  # middleware guarantees this never happens for tool calls
        raise RuntimeError("No authenticated project on this request")
    return ctx


# ── Tools ───────────────────────────────────────────────────────────────────

@mcp_server.tool()
def get_project_overview(since: str = "", until: str = "", environment: str = "") -> dict:
    """Traffic + error + latency summary for the project: total requests,
    client/server error counts and rates, avg/p95 latency, unique endpoints
    and consumers, plus the environments that have data. Start here."""
    from apps.projects.services import AnalyticsService

    project_id, slug = _project()
    close_old_connections()
    summary = AnalyticsService.get_project_summary(
        project_id=project_id, since=since or None, until=until or None,
        environment=environment or None,
    )
    return {
        "project": slug,
        "summary": summary,
        "environments": AnalyticsService.get_project_environments(project_id),
    }


@mcp_server.tool()
def search_requests(
    filter: str = "",
    since: str = "",
    until: str = "",
    environment: str = "",
    page: int = 1,
    page_size: int = 25,
) -> dict:
    """Search the request log with a rich filter string.

    Filter grammar: `field:op:value;field:op:value` (AND), comma for OR values,
    leading `-` negates. Fields: app, method, status, status_class (1xx..5xx),
    path, latency (ms), env, consumer, req_size, resp_size, ip, ua, release.
    Example: `status_class:is:5xx;latency:gt:500;path:contains:/orders`."""
    from apps.projects.services import DataQueryService

    project_id, _ = _project()
    close_old_connections()
    return DataQueryService.get_project_requests(
        project_id=project_id,
        since=since or None,
        until=until or None,
        environment=environment or None,
        filter=filter or None,
        page=max(1, page),
        page_size=max(1, min(page_size, 100)),
    )


@mcp_server.tool()
def list_error_issues(since: str = "", until: str = "", search: str = "", limit: int = 25) -> list[dict]:
    """Error issues (grouped exceptions/5xx, Sentry-style), most frequent
    first: fingerprint, endpoint, message, occurrences, affected consumers,
    first/last seen, lifecycle status, last release, and the latest stack
    trace. The fingerprint is the key for get_error_events,
    suspect_commits, and start_investigation."""
    from apps.projects.services import DataQueryService

    project_id, _ = _project()
    close_old_connections()
    return DataQueryService.get_project_error_issues(
        project_id=project_id, since=since or None, until=until or None,
        search=search or None, limit=max(1, min(limit, 100)),
    )


@mcp_server.tool()
def get_error_events(fingerprint: str, since: str = "", until: str = "", limit: int = 10) -> list[dict]:
    """Individual occurrences of one error issue (by fingerprint), newest
    first, each with message, full stack trace, consumer, release/commit, and
    trace_id (feed trace_id to get_trace for the request's span waterfall)."""
    from apps.projects.services import DataQueryService

    project_id, _ = _project()
    close_old_connections()
    return DataQueryService.get_project_error_events(
        project_id=project_id, fingerprint=fingerprint,
        since=since or None, until=until or None, limit=max(1, min(limit, 50)),
    )


@mcp_server.tool()
def get_trace(trace_id: str) -> dict:
    """All spans of one distributed trace (the request's waterfall): server
    span plus outbound HTTP calls with durations and statuses. Also returns
    the captured request/response for the trace when available."""
    from apps.projects.services import DataQueryService

    project_id, _ = _project()
    close_old_connections()
    result = DataQueryService.get_trace_spans(project_id, trace_id)
    request = DataQueryService.get_request_by_trace(project_id, trace_id)
    if request is not None:
        request["timestamp"] = str(request.get("timestamp"))
    result["request"] = request
    for s in result.get("spans", []):
        s["timestamp"] = str(s.get("timestamp"))
    return result


@mcp_server.tool()
def get_endpoint_stats(method: str, path: str, since: str = "", until: str = "", environment: str = "") -> dict:
    """Detailed stats for one endpoint (templated path like /orders/{id}):
    volume, error split, latency percentiles, status-code breakdown, and
    slow-request count."""
    from apps.projects.services import AnalyticsService

    project_id, _ = _project()
    close_old_connections()
    return AnalyticsService.get_project_endpoint_detail(
        project_id=project_id, method=(method or "GET").upper(), path=path,
        since=since or None, until=until or None, environment=environment or None,
    )


@mcp_server.tool()
def consumer_impact(search: str = "", since: str = "", until: str = "", limit: int = 25) -> list[dict]:
    """Per-consumer stats ranked by volume: requests, client 4xx / server 5xx
    rates, avg latency, last seen. Use to answer 'who is affected?' —
    APILens's consumer identity is attached to every request and error."""
    from apps.projects.services import AnalyticsService

    project_id, _ = _project()
    close_old_connections()
    return AnalyticsService.get_project_consumer_stats(
        project_id=project_id, search=search or None,
        since=since or None, until=until or None, limit=max(1, min(limit, 100)),
    )


@mcp_server.tool()
def list_deploys(since: str = "", until: str = "", environment: str = "", limit: int = 25) -> list[dict]:
    """Deploy/release events (release, commit, environment, app, time) —
    correlate error onset with what shipped."""
    from apps.projects.services import DeployService

    project_id, _ = _project()
    close_old_connections()
    return DeployService.list_deploys(
        project_id=project_id, since=since or None, until=until or None,
        environment=environment or None, limit=max(1, min(limit, 100)),
    )


@mcp_server.tool()
def suspect_commits(fingerprint: str) -> dict:
    """Suspect commits for an error issue: recent commits touching the files
    in its stack trace, scoped to the commit that was running (requires the
    project's GitHub integration + code mappings). Also returns per-frame
    source links."""
    from apps.integrations.services import SuspectCommitService
    from apps.projects.models import ErrorIssue, Project
    from apps.projects.services import DataQueryService

    project_id, _ = _project()
    close_old_connections()
    project = Project.objects.filter(id=project_id).first()
    events = DataQueryService.get_project_error_events(
        project_id=project_id, fingerprint=fingerprint, limit=1,
    )
    if not project or not events:
        return {"suspect_commits": [], "frame_links": [], "reason": "no_events"}
    issue = ErrorIssue.objects.filter(project=project, fingerprint=fingerprint).first()
    event = events[0]
    return SuspectCommitService.for_event(
        project,
        issue.app_id if issue else None,
        str(event.get("payload") or ""),
        str(event.get("commit_sha") or ""),
        event.get("timestamp"),
    )


@mcp_server.tool()
def start_investigation(fingerprint: str) -> dict:
    """Kick off APILens's staged AI root-cause investigation for an error
    issue (evidence assembly → root cause → fix plan). Returns immediately;
    poll get_investigation for the result. Reuses an in-flight run if one is
    already going."""
    from apps.ai.services import InvestigationService
    from apps.projects.models import Project

    project_id, _ = _project()
    close_old_connections()
    project = Project.objects.filter(id=project_id).first()
    if project is None:
        return {"error": "project not found"}
    try:
        inv = InvestigationService.start(project, fingerprint, user=None)
    except Exception as exc:  # noqa: BLE001 — surface as data, not a protocol error
        return {"error": str(exc)}
    return InvestigationService.serialize(inv)


@mcp_server.tool()
def get_investigation(fingerprint: str) -> dict:
    """Latest AI investigation for an error issue: status
    (queued/running/completed/failed), root cause + confidence, evidence
    trail, fix plan, and patch sketch."""
    from apps.ai.services import InvestigationService
    from apps.projects.models import Project

    project_id, _ = _project()
    close_old_connections()
    project = Project.objects.filter(id=project_id).first()
    if project is None:
        return {"exists": False, "error": "project not found"}
    return InvestigationService.serialize(InvestigationService.get_latest(project, fingerprint))


@mcp_server.tool()
def get_fix_brief(fingerprint: str) -> dict:
    """The complete fix brief for an error issue: impact, AI root cause + fix
    plan (when investigated), stack trace, suspect commits, repo paths, and a
    repro cURL of the captured failing request. Start here when asked to fix
    an APILens issue."""
    from apps.ai.fix_brief import build_fix_brief
    from apps.projects.models import Project

    project_id, _ = _project()
    close_old_connections()
    project = Project.objects.filter(id=project_id).first()
    if project is None:
        return {"error": "project not found"}
    return build_fix_brief(project, fingerprint)


@mcp_server.tool()
def resolve_issue(fingerprint: str, release: str = "") -> dict:
    """Mark an error issue resolved after fixing it (optionally naming the
    release carrying the fix). APILens then watches the fingerprint: a deploy
    with no recurrence marks it verified in production; recurrence auto-flips
    it to regressed."""
    from apps.projects.models import Project
    from apps.projects.services import ErrorIssueService

    project_id, _ = _project()
    close_old_connections()
    project = Project.objects.filter(id=project_id).first()
    if project is None:
        return {"error": "project not found"}
    try:
        issue = ErrorIssueService.set_status(project, fingerprint, "resolved", release)
    except Exception as exc:  # noqa: BLE001 — surface as data
        return {"error": str(exc)}
    return {"fingerprint": issue.fingerprint, "status": issue.status}


@mcp_server.tool()
def get_issue_verification(fingerprint: str) -> dict:
    """Post-deploy verification state for a resolved issue: the deploy that
    shipped after resolution, recurrence count since, and the verified
    verdict."""
    from apps.projects.models import Project
    from apps.projects.services import ErrorIssueService

    project_id, _ = _project()
    close_old_connections()
    project = Project.objects.filter(id=project_id).first()
    if project is None:
        return {"exists": False}
    return ErrorIssueService.get_verification(project, fingerprint)


@mcp_server.tool()
def get_postmortem(fingerprint: str) -> dict:
    """The incident postmortem for a resolved/investigated issue (timeline,
    impact, root cause, resolution, verification). Generates on demand if none
    exists yet; poll until status=completed."""
    from apps.ai.services import PostmortemService
    from apps.projects.models import Project

    project_id, _ = _project()
    close_old_connections()
    project = Project.objects.filter(id=project_id).first()
    if project is None:
        return {"exists": False, "error": "project not found"}
    existing = PostmortemService.get_latest(project, fingerprint)
    if existing is None:
        try:
            existing = PostmortemService.start(project, fingerprint, user=None)
        except Exception as exc:  # noqa: BLE001
            return {"exists": False, "error": str(exc)}
    return PostmortemService.serialize(existing)


@mcp_server.tool()
def get_health_digest(days: int = 7) -> dict:
    """An API-health rollup for the last `days`: totals + error rate vs the
    prior period, new/regressed/resolved issues, worst and slowest endpoints,
    top consumers, and API-surface changes (endpoints appeared/disappeared)."""
    from apps.ai.narrator import assemble_digest, narrate_digest, render_digest_markdown
    from apps.projects.models import Project

    project_id, _ = _project()
    close_old_connections()
    project = Project.objects.filter(id=project_id).first()
    if project is None:
        return {"error": "project not found"}
    digest = assemble_digest(project, days=max(1, min(int(days), 30)))
    return {
        "narrative": narrate_digest(digest),
        "markdown": render_digest_markdown(digest),
        "summary": digest["summary"],
        "new_issues": digest["new_issues"],
        "regressed": digest["regressed"],
        "resolved": digest["resolved"],
        "surface": digest["surface"],
    }


# ── ASGI app with API-key auth ──────────────────────────────────────────────

def _authenticate(api_key: str) -> tuple[str, str] | None:
    """Project API key → (project_id, slug). Same SHA-256 lookup the
    control plane's ApiKeyAuth uses."""
    if not api_key:
        return None
    from apps.auth.models import ApiKey

    close_old_connections()
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()
    row = (
        ApiKey.objects.active()
        .select_related("project")
        .filter(key_hash=key_hash, project__is_active=True)
        .first()
    )
    if row is None:
        return None
    return str(row.project_id), row.project.slug


class ApiKeyAuthMiddleware:
    """Reject unauthenticated requests; stash the project on a contextvar."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        api_key = headers.get("x-api-key", "")
        if not api_key:
            auth = headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                api_key = auth[7:].strip()

        import anyio.to_thread

        ctx = await anyio.to_thread.run_sync(_authenticate, api_key)
        if ctx is None:
            from starlette.responses import JSONResponse

            resp = JSONResponse(
                {"error": "authentication_error", "detail": "Valid project API key required (X-API-Key or Bearer)"},
                status_code=401,
            )
            await resp(scope, receive, send)
            return

        token = _project_ctx.set(ctx)
        try:
            await self.app(scope, receive, send)
        finally:
            _project_ctx.reset(token)


app = ApiKeyAuthMiddleware(mcp_server.streamable_http_app())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8300")))
