"""Investigation lifecycle: start (dedupe in-flight runs), fetch, serialize."""

from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from core.exceptions.base import ValidationError

from .models import Investigation


class InvestigationService:
    @staticmethod
    def ai_configured() -> bool:
        return bool(getattr(settings, "AI_API_KEY", ""))

    @staticmethod
    def start(project, fingerprint: str, user) -> Investigation:
        """Queue an investigation and kick the worker thread.

        In-flight dedupe: if one is already queued/running for this issue
        (started <10 min ago), return it instead of double-spending tokens.
        Completed runs don't block a re-run."""
        from . import investigator

        fingerprint = (fingerprint or "").strip()
        if not fingerprint:
            raise ValidationError("fingerprint is required")
        if not InvestigationService.ai_configured():
            raise ValidationError(
                "AI is not configured on this server (set APILENS_AI_API_KEY)"
            )

        in_flight = (
            Investigation.objects.filter(
                project=project,
                fingerprint=fingerprint,
                status__in=[Investigation.Status.QUEUED, Investigation.Status.RUNNING],
                created_at__gte=timezone.now() - timedelta(minutes=10),
            )
            .order_by("-created_at")
            .first()
        )
        if in_flight is not None:
            return in_flight

        from apps.projects.models import ErrorIssue

        issue = ErrorIssue.objects.filter(project=project, fingerprint=fingerprint).first()
        inv = Investigation.objects.create(
            project=project,
            fingerprint=fingerprint,
            issue_title=(issue.title if issue else "")[:300],
            created_by=user,
        )
        investigator.start_async(str(inv.id))
        return inv

    @staticmethod
    def get_latest(project, fingerprint: str) -> Investigation | None:
        return (
            Investigation.objects.filter(project=project, fingerprint=(fingerprint or "").strip())
            .order_by("-created_at")
            .first()
        )

    @staticmethod
    def serialize(inv: Investigation | None) -> dict:
        if inv is None:
            return {"exists": False, "ai_configured": InvestigationService.ai_configured()}
        return {
            "exists": True,
            "ai_configured": True,
            "id": str(inv.id),
            "fingerprint": inv.fingerprint,
            "status": inv.status,
            "issue_title": inv.issue_title,
            "root_cause": inv.root_cause,
            "confidence": inv.confidence,
            "explanation": inv.explanation,
            "impact_summary": inv.impact_summary,
            "evidence": inv.evidence or [],
            "fix_steps": inv.fix_steps or [],
            "patch_suggestion": inv.patch_suggestion,
            "risk_notes": inv.risk_notes,
            "model": inv.model,
            "input_tokens": inv.input_tokens,
            "output_tokens": inv.output_tokens,
            "error": inv.error,
            "created_at": inv.created_at.isoformat() if inv.created_at else None,
            "completed_at": inv.completed_at.isoformat() if inv.completed_at else None,
        }


class PostmortemService:
    @staticmethod
    def start(project, fingerprint: str, user) -> "object":
        from datetime import timedelta

        from django.utils import timezone

        from core.exceptions.base import ValidationError

        from . import narrator
        from .models import Postmortem

        fingerprint = (fingerprint or "").strip()
        if not fingerprint:
            raise ValidationError("fingerprint is required")

        in_flight = (
            Postmortem.objects.filter(
                project=project, fingerprint=fingerprint,
                status__in=[Postmortem.Status.QUEUED, Postmortem.Status.RUNNING],
                created_at__gte=timezone.now() - timedelta(minutes=10),
            )
            .order_by("-created_at")
            .first()
        )
        if in_flight is not None:
            return in_flight

        pm = Postmortem.objects.create(project=project, fingerprint=fingerprint, created_by=user)
        narrator.start_postmortem_async(str(pm.id))
        return pm

    @staticmethod
    def get_latest(project, fingerprint: str):
        from .models import Postmortem

        return (
            Postmortem.objects.filter(project=project, fingerprint=(fingerprint or "").strip())
            .order_by("-created_at")
            .first()
        )

    @staticmethod
    def serialize(pm) -> dict:
        if pm is None:
            return {"exists": False, "ai_configured": InvestigationService.ai_configured()}
        return {
            "exists": True,
            "id": str(pm.id),
            "status": pm.status,
            "title": pm.title,
            "summary": pm.summary,
            "markdown": pm.markdown,
            "model": pm.model,
            "input_tokens": pm.input_tokens,
            "output_tokens": pm.output_tokens,
            "error": pm.error,
            "created_at": pm.created_at.isoformat() if pm.created_at else None,
        }
