"""Integration callbacks that arrive from outside the dashboard session.

The GitHub webhook is unauthenticated JWT-wise but MUST carry a valid
X-Hub-Signature-256 (HMAC over the raw body with our webhook secret,
constant-time compared). Events handled: installation lifecycle
(deleted/suspend/unsuspend) and installation_repositories (removed).
"""

import json
import logging

from django.http import HttpRequest
from ninja import Router

from apps.auth.authentication import jwt_auth

logger = logging.getLogger(__name__)

router = Router()


@router.post("/github/complete", auth=jwt_auth, response=dict)
def github_complete_installation(request: HttpRequest, data: dict):
    """Finish the GitHub App install flow (called by the setup callback page).

    Not project-scoped on purpose: GitHub only passes `state` through the
    install redirect, so the project is resolved from the signed state and the
    caller must hold admin on it. The installation_id is verified against
    GitHub as the app (the redirect's value is untrusted — see design doc)."""
    from django.core import signing

    from apps.projects.services import ProjectService
    from apps.integrations.services import GitHubIntegrationService, _STATE_SALT, _STATE_MAX_AGE_SECONDS
    from core.exceptions.base import ValidationError

    state = str(data.get("state") or "")
    try:
        payload = signing.loads(state, salt=_STATE_SALT, max_age=_STATE_MAX_AGE_SECONDS)
    except signing.BadSignature as exc:
        raise ValidationError("Invalid or expired installation state") from exc

    from apps.projects.models import Project

    project = Project.objects.filter(id=payload.get("project_id"), is_active=True).first()
    if project is None:
        raise ValidationError("Project in installation state no longer exists")
    ProjectService.authorize(request.auth, project, "admin")

    install = GitHubIntegrationService.complete_installation(
        project, request.auth, data.get("installation_id"), state
    )
    return {
        "id": str(install.id),
        "account_login": install.account_login,
        "status": install.status,
        "project_slug": project.slug,
    }


@router.post("/github/webhook", auth=None, response=dict)
def github_webhook(request: HttpRequest):
    from apps.integrations.services import GitHubIntegrationService

    signature = request.headers.get("X-Hub-Signature-256", "")
    if not GitHubIntegrationService.verify_webhook_signature(request.body, signature):
        logger.warning("GitHub webhook rejected: bad or missing signature")
        return {"handled": False, "reason": "invalid_signature"}

    event = request.headers.get("X-GitHub-Event", "")
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return {"handled": False, "reason": "invalid_payload"}

    try:
        return GitHubIntegrationService.handle_webhook(event, payload)
    except Exception:
        # Webhooks are retried by GitHub; log and ack rather than 500-looping.
        logger.exception("GitHub webhook handling failed for event %s", event)
        return {"handled": False, "reason": "error"}
