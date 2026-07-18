"""The Investigator — staged AI root-cause analysis over one error issue.

Seer-style pipeline (see AI_NATIVE_PLAN.md, feature F3), built on the Agno
agent framework:

    1. Evidence assembly (deterministic, no LLM): the issue entity, its latest
       error events (stack traces), the failing trace's span waterfall, the
       exact captured request (redacted payloads/headers), suspect commits,
       deploys around first-seen, and blast radius. All from our own stores —
       this is the context advantage no generic tool has.
    2. Root-cause agent (structured output). It may call the read_source_file
       tool to read the app's actual code at the exact commit that was
       running (Phase 0 stamp + Phase 1 code mappings).
    3. Fix-plan agent (structured output), grounded in the confirmed root
       cause.

Runs in a background thread; progress/results live on the Investigation row
and the API is poll-based. Every failure path marks the row failed with a
reason — an AI outage must never take the Errors page down with it.
"""

from __future__ import annotations

import logging
import threading
from datetime import timedelta

from django.db import close_old_connections
from django.utils import timezone
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_MAX_PAYLOAD_CHARS = 2_000
_MAX_HEADERS_CHARS = 1_000
_MAX_STACK_CHARS = 8_000
_MAX_TRACE_SPANS = 30
_MAX_EVENTS = 3
# Scan more occurrences than we render, to find one with a sampled trace.
_EVENT_SCAN_LIMIT = 50
_MAX_TOOL_FILE_CHARS = 12_000
_MAX_TOOL_CALLS = 4


# ── Structured outputs ──────────────────────────────────────────────────────

class EvidenceItem(BaseModel):
    source: str = Field(description="Which evidence this cites: stack_trace | trace_waterfall | request | suspect_commit | deploy | impact | source_code")
    detail: str = Field(description="One sentence: what this evidence shows and why it matters")


class RootCauseAnalysis(BaseModel):
    root_cause: str = Field(description="One-paragraph root cause. Name the exact file/function/line when the evidence supports it.")
    confidence: str = Field(description="high | medium | low — high only when the stack trace AND at least one other evidence source agree")
    explanation: str = Field(description="The causal chain from trigger to failure, walking the evidence step by step")
    impact_summary: str = Field(description="Who/what is affected: consumers, endpoints, share of traffic, first/last seen — lead with this")
    evidence: list[EvidenceItem] = Field(description="Every evidence source actually used, with what it contributed")


class FixPlan(BaseModel):
    steps: list[str] = Field(description="Ordered, concrete engineering steps to fix the root cause (not to mask the symptom)")
    patch_suggestion: str = Field(description="A minimal unified-diff-style or code-block sketch of the core change, if the root cause is code-level; else empty string")
    risk_notes: str = Field(description="What could go wrong applying this fix and what to verify after deploying")


# ── Evidence assembly ───────────────────────────────────────────────────────

def _clip(text: str, limit: int) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "…[truncated]"


def assemble_evidence(project, fingerprint: str) -> dict:
    """Everything we know about this issue, from our own datastores."""
    from apps.integrations.services import SuspectCommitService
    from apps.projects.models import ErrorIssue
    from apps.projects.services import DataQueryService, DeployService

    issue = ErrorIssue.objects.filter(project=project, fingerprint=fingerprint).first()

    # Fetch a wider candidate set than we render, so we can find a *traced*
    # occurrence for the waterfall + captured request — SDKs sample traces, so
    # the few newest events usually have none. We still only show the top
    # _MAX_EVENTS stack traces in the bundle.
    candidates = DataQueryService.get_project_error_events(
        project_id=str(project.id),
        fingerprint=fingerprint,
        since=(timezone.now() - timedelta(days=30)).isoformat(),
        limit=_EVENT_SCAN_LIMIT,
    )
    events = candidates[:_MAX_EVENTS]

    # Prefer the most recent event that actually carries a trace_id; fall back
    # to the newest event (its stack trace is representative either way).
    latest = next((e for e in candidates if str(e.get("trace_id") or "")), events[0] if events else {})
    trace_id = str(latest.get("trace_id") or "")
    trace = DataQueryService.get_trace_spans(str(project.id), trace_id) if trace_id else {"spans": []}
    request = DataQueryService.get_request_by_trace(str(project.id), trace_id) if trace_id else None

    suspects = SuspectCommitService.for_event(
        project,
        issue.app_id if issue else None,
        str(latest.get("payload") or ""),
        str(latest.get("commit_sha") or ""),
        latest.get("timestamp"),
    ) if latest else {"suspect_commits": [], "frame_links": [], "reason": "no_events"}

    deploys = DeployService.list_deploys(
        project_id=str(project.id),
        since=(timezone.now() - timedelta(days=14)).isoformat(),
        limit=10,
    )

    return {
        "issue": issue,
        "events": events,
        "trace": trace,
        "request": request,
        "suspects": suspects,
        "deploys": deploys,
    }


def render_evidence(evidence: dict) -> str:
    """Compact, size-capped text bundle the agents reason over."""
    parts: list[str] = []
    issue = evidence.get("issue")
    if issue is not None:
        parts.append(
            "## Issue\n"
            f"title: {issue.title}\n"
            f"exception_type: {issue.exception_type}\n"
            f"endpoint: {issue.endpoint_method} {issue.endpoint_path}\n"
            f"status_code: {issue.last_status_code}\n"
            f"lifecycle: {issue.status} | events≈{issue.events_count} | "
            f"first_seen: {issue.first_seen_at:%Y-%m-%d %H:%M} | last_seen: {issue.last_seen_at:%Y-%m-%d %H:%M}\n"
            f"first_release: {issue.first_release or '-'} | last_release: {issue.last_release or '-'}"
        )

    for i, ev in enumerate(evidence.get("events") or []):
        stack = _clip(ev.get("payload") or "", _MAX_STACK_CHARS if i == 0 else 1_500)
        parts.append(
            f"## Error event {i + 1} ({ev.get('timestamp')})\n"
            f"message: {ev.get('message')}\n"
            f"consumer: {ev.get('consumer_name') or ev.get('consumer_id') or '-'}\n"
            f"release: {ev.get('release') or '-'} commit: {ev.get('commit_sha') or '-'}\n"
            + (f"stack trace:\n{stack}" if stack else "stack trace: (none captured)")
        )

    spans = (evidence.get("trace") or {}).get("spans") or []
    if spans:
        lines = []
        for s in spans[:_MAX_TRACE_SPANS]:
            lines.append(
                f"- [{s.get('kind')}] {s.get('name')} · {round(float(s.get('duration_ms') or 0), 1)}ms"
                f" · status={s.get('status')}({s.get('status_code')}) · service={s.get('service_name') or '-'}"
            )
        parts.append("## Trace waterfall (the failing request's spans)\n" + "\n".join(lines))

    req = evidence.get("request")
    if req:
        parts.append(
            "## Captured request (values pre-redacted by the SDK)\n"
            f"{req.get('method')} {req.get('raw_path')} → {req.get('status_code')} in {round(float(req.get('response_time_ms') or 0), 1)}ms\n"
            f"environment: {req.get('environment')} | consumer: {req.get('consumer_name') or req.get('consumer_id') or '-'}\n"
            f"request_headers: {_clip(req.get('request_headers') or '', _MAX_HEADERS_CHARS)}\n"
            f"request_body: {_clip(req.get('request_payload') or '', _MAX_PAYLOAD_CHARS)}\n"
            f"response_body: {_clip(req.get('response_payload') or '', _MAX_PAYLOAD_CHARS)}"
        )

    suspects = evidence.get("suspects") or {}
    commits = suspects.get("suspect_commits") or []
    if commits:
        lines = [
            f"- {c.get('short_sha')} \"{c.get('message')}\" by {c.get('author_login') or c.get('author_name')}"
            f" at {c.get('date')} touching {', '.join(c.get('files') or [])}"
            for c in commits
        ]
        parts.append("## Suspect commits (recent commits touching the stack-trace files, scoped to the running commit)\n" + "\n".join(lines))
    frame_links = suspects.get("frame_links") or []
    if frame_links:
        lines = [f"- {f['path']}:{f['line']} in {f['function']} → repo path {f['mapped_path']}" for f in frame_links[:6]]
        parts.append("## In-app frames (code mappings resolved)\n" + "\n".join(lines))

    deploys = evidence.get("deploys") or []
    if deploys:
        lines = [
            f"- {d['deployed_at']}: {d['release']} ({d.get('commit') or '-'}) env={d['environment']} app={d.get('app_slug') or 'project-wide'}"
            for d in deploys
        ]
        parts.append("## Recent deploys (last 14 days)\n" + "\n".join(lines))

    return "\n\n".join(parts) if parts else "(no evidence found for this issue)"


# ── Agno pipeline ───────────────────────────────────────────────────────────

def _build_model():
    """Provider-agnostic model (LiteLLM). Kept as a thin alias so existing
    callers importing `_build_model` from here keep working."""
    from .llm import build_model

    return build_model()


def _make_source_tool(evidence: dict):
    """read_source_file tool: lets the RCA agent read the app's real code at
    the exact commit that was running. Bounded: whitelisted to mapped paths'
    repos, size-capped, max a handful of calls."""
    from apps.integrations import github_client
    from apps.integrations.models import CodeMapping
    from apps.integrations.services import CodeMappingService

    issue = evidence.get("issue")
    latest = (evidence.get("events") or [{}])[0]
    commit = str(latest.get("commit_sha") or "")
    mappings = (
        list(
            CodeMapping.objects.filter(app_id=issue.app_id, repository__is_active=True)
            .select_related("repository", "repository__installation")
        )
        if issue is not None and issue.app_id
        else []
    )
    calls = {"n": 0}

    def read_source_file(runtime_path: str) -> str:
        """Read the application source file for a stack-trace path (e.g.
        "/app/store/payments.py") at the exact commit that was running when
        the error happened. Returns the file text, or an explanation of why it
        is unavailable. Use this to confirm the root cause in real code."""
        if calls["n"] >= _MAX_TOOL_CALLS:
            return "Tool budget exhausted — reason from the evidence you already have."
        calls["n"] += 1
        if not mappings:
            return "No code mappings configured for this app — cannot read source."
        resolved = CodeMappingService.resolve(mappings, runtime_path)
        if resolved is None:
            return f"Path {runtime_path} matches no code mapping (likely a library frame)."
        mapping, mapped_path = resolved
        repo = mapping.repository
        ref = commit or mapping.branch or repo.default_branch or "main"
        try:
            content = github_client.get_file_content(
                repo.installation.installation_id,
                repo.full_name,
                mapped_path,
                ref=ref,
                base_url=repo.installation.base_url,
            )
        except Exception as exc:  # noqa: BLE001 — tool must answer, not raise
            return f"Could not read {repo.full_name}/{mapped_path}@{ref}: {exc}"
        if not content:
            return f"{repo.full_name}/{mapped_path}@{ref} is missing, binary, or too large."
        return f"# {repo.full_name}/{mapped_path} @ {ref}\n" + _clip(content, _MAX_TOOL_FILE_CHARS)

    return read_source_file


def run_pipeline(evidence: dict) -> dict:
    """Two structured Agno agent runs: root cause, then fix plan."""
    from agno.agent import Agent

    model_id, model = _build_model()
    bundle = render_evidence(evidence)

    rca_agent = Agent(
        model=model,
        tools=[_make_source_tool(evidence)],
        output_schema=RootCauseAnalysis,
        telemetry=False,
        description=(
            "You are APILens's production error investigator. You are given the full "
            "observability evidence for ONE error issue in an HTTP API: the grouped issue, "
            "recent occurrences with stack traces, the failing request's distributed-trace "
            "waterfall, the exact captured request/response, suspect commits, and recent "
            "deploys. Determine the root cause.\n"
            "Rules: reason ONLY from the evidence; never invent files, values, or commits. "
            "Use read_source_file to confirm code-level hypotheses in the real source when "
            "code mappings exist. confidence=high only when the stack trace AND at least one "
            "other source (source code, suspect commit, request payload, or trace) agree. "
            "If evidence is thin, say so and mark confidence low."
        ),
    )
    from .llm import structured

    rca_run = rca_agent.run(f"Investigate this production error issue.\n\n{bundle}")
    rca: RootCauseAnalysis = structured(rca_run, RootCauseAnalysis)

    fix_agent = Agent(
        model=model,
        output_schema=FixPlan,
        telemetry=False,
        description=(
            "You are APILens's fix planner. Given the confirmed root cause of a production "
            "API error and its evidence, produce a minimal, safe engineering fix plan. "
            "Fix the cause, not the symptom; keep the patch sketch small and grounded in "
            "the files named by the analysis; note deploy-time verification steps."
        ),
    )
    fix_run = fix_agent.run(
        "Root cause analysis:\n"
        f"{rca.model_dump_json(indent=1)}\n\n"
        "Key evidence (for file/line references):\n"
        f"{_clip(bundle, 6_000)}\n\n"
        "Produce the fix plan."
    )
    fix: FixPlan = structured(fix_run, FixPlan)

    def _tokens(run, attr):
        try:
            return int(getattr(run.metrics, attr, 0) or 0)
        except Exception:
            return 0

    return {
        "model": model_id,
        "rca": rca,
        "fix": fix,
        "input_tokens": _tokens(rca_run, "input_tokens") + _tokens(fix_run, "input_tokens"),
        "output_tokens": _tokens(rca_run, "output_tokens") + _tokens(fix_run, "output_tokens"),
    }


# ── Runner ──────────────────────────────────────────────────────────────────

def run_investigation(investigation_id: str) -> None:
    """Execute one queued Investigation to completion (called on a worker
    thread). All failures land on the row, never propagate."""
    from .models import Investigation

    close_old_connections()
    inv = Investigation.objects.filter(id=investigation_id).first()
    if inv is None:
        return
    inv.status = Investigation.Status.RUNNING
    inv.started_at = timezone.now()
    inv.save(update_fields=["status", "started_at"])

    try:
        evidence = assemble_evidence(inv.project, inv.fingerprint)
        if not (evidence.get("events") or []):
            raise RuntimeError("No error events found for this issue in the last 30 days")
        result = run_pipeline(evidence)
        rca: RootCauseAnalysis = result["rca"]
        fix: FixPlan = result["fix"]
        inv.root_cause = rca.root_cause
        inv.confidence = (rca.confidence or "").strip().lower()[:8]
        inv.explanation = rca.explanation
        inv.impact_summary = rca.impact_summary
        inv.evidence = [e.model_dump() for e in rca.evidence]
        inv.fix_steps = list(fix.steps or [])
        inv.patch_suggestion = fix.patch_suggestion or ""
        inv.risk_notes = fix.risk_notes or ""
        inv.model = result["model"]
        inv.input_tokens = result["input_tokens"]
        inv.output_tokens = result["output_tokens"]
        inv.status = Investigation.Status.COMPLETED
        inv.error = ""
    except Exception as exc:  # noqa: BLE001 — failure is a row state, not a 500
        logger.warning("investigation %s failed: %s", investigation_id, exc, exc_info=True)
        inv.status = Investigation.Status.FAILED
        inv.error = str(exc)[:1000]
    finally:
        inv.completed_at = timezone.now()
        inv.save()
        close_old_connections()


def start_async(investigation_id: str) -> None:
    threading.Thread(
        target=run_investigation,
        args=(str(investigation_id),),
        daemon=True,
        name=f"investigator-{str(investigation_id)[:8]}",
    ).start()
