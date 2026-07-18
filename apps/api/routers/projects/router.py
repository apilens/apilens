"""
Project-scoped API router.

This router provides all project-level operations including:
- Project CRUD
- Project-scoped apps
- Project-scoped API keys
- Project-level analytics (aggregated across apps)
"""

from django.http import HttpRequest
from django.db import transaction
from ninja import Router

from apps.auth.services import ApiKeyService
from apps.projects.models import App
from apps.projects.services import (
    ProjectService,
    AppService,
    AnalyticsService,
    DataQueryService,
    DeployService,
)
from apps.projects.membership import MembershipService
from apps.users.models import User
from apps.users.services import UserService
from apps.auth.authentication import jwt_auth

from .schemas import (
    CreateProjectRequest,
    UpdateProjectRequest,
    ProjectResponse,
    ProjectListResponse,
    CreateAppRequest,
    UpdateAppRequest,
    AppResponse,
    AppListResponse,
    CreateApiKeyRequest,
    CreateApiKeyResponse,
    ApiKeyResponse,
    MessageResponse,
    LogsQueryResponse,
    RequestsQueryResponse,
    TraceQueryResponse,
    AnalyticsTimeseriesPointResponse,
    MembersListResponse,
    InvitationResponse,
    InviteMemberRequest,
    UpdateMemberRoleRequest,
    AcceptInvitationRequest,
    PendingInvitationResponse,
    AcceptResultResponse,
)

router = Router(auth=[jwt_auth])


# ── Project CRUD ──────────────────────────────────────────────────────


@router.post("/", response={201: ProjectResponse})
def create_project(request: HttpRequest, data: CreateProjectRequest):
    """Create a new project."""
    user: User = request.auth
    with transaction.atomic():
        project = ProjectService.create_project(user, data.name, data.description)

        # Auto-create a default API key and roll back project creation if it fails.
        ApiKeyService.create_key(project, f"{project.name} API Key")

    return 201, ProjectResponse.from_orm(project)


@router.get("/", response=list[ProjectListResponse])
def list_projects(request: HttpRequest):
    """List all projects for the authenticated user."""
    user: User = request.auth
    projects = ProjectService.list_projects(user)

    # Include app count for each project
    result = []
    for project in projects:
        app_count = App.objects.filter(project=project, is_active=True).count()
        result.append(ProjectListResponse.from_orm(project, app_count=app_count))

    return result


@router.get("/{project_slug}", response=ProjectResponse)
def get_project(request: HttpRequest, project_slug: str):
    """Get a specific project by slug."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return ProjectResponse.from_orm(project)


@router.patch("/{project_slug}", response=ProjectResponse)
def update_project(request: HttpRequest, project_slug: str, data: UpdateProjectRequest):
    """Update a project's details."""
    user: User = request.auth
    project = ProjectService.update_project(user, project_slug, data.name, data.description)
    return ProjectResponse.from_orm(project)


@router.delete("/{project_slug}", response=MessageResponse)
def delete_project(request: HttpRequest, project_slug: str):
    """Soft delete a project (also soft-deletes all apps and revokes all API keys)."""
    user: User = request.auth
    ProjectService.delete_project(user, project_slug)
    return MessageResponse(message="Project deleted successfully")


# ── Project-scoped Apps ──────────────────────────────────────────────


@router.post("/{project_slug}/apps", response={201: AppResponse})
def create_app(request: HttpRequest, project_slug: str, data: CreateAppRequest):
    """Create a new app within a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    app = AppService.create_app(project, data.name, data.description, data.framework, data.slug)
    return 201, AppResponse.from_orm(app)


@router.get("/{project_slug}/apps", response=list[AppListResponse])
def list_apps(request: HttpRequest, project_slug: str):
    """List all apps in a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    apps = AppService.list_apps(project)
    return [AppListResponse.from_orm(app) for app in apps]


@router.get("/{project_slug}/apps/{app_slug}", response=AppResponse)
def get_app(request: HttpRequest, project_slug: str, app_slug: str):
    """Get a specific app within a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    app = AppService.get_app_by_slug(project, app_slug)
    return AppResponse.from_orm(app)


@router.patch("/{project_slug}/apps/{app_slug}", response=AppResponse)
def update_app(request: HttpRequest, project_slug: str, app_slug: str, data: UpdateAppRequest):
    """Update an app's details."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    app = AppService.update_app(project, app_slug, data.name, data.description, data.framework)
    return AppResponse.from_orm(app)


@router.delete("/{project_slug}/apps/{app_slug}", response=MessageResponse)
def delete_app(request: HttpRequest, project_slug: str, app_slug: str):
    """Soft delete an app within a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    AppService.delete_app(project, app_slug)
    return MessageResponse(message="App deleted successfully")


# ── Project-scoped API Keys ──────────────────────────────────────────


@router.post("/{project_slug}/api-keys", response={201: CreateApiKeyResponse})
def create_api_key(request: HttpRequest, project_slug: str, data: CreateApiKeyRequest):
    """Create a new API key for a project (works across all apps in project)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    raw_key, api_key = ApiKeyService.create_key(project, data.name.strip())
    return 201, CreateApiKeyResponse(
        key=raw_key,
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        created_at=api_key.created_at,
    )


@router.get("/{project_slug}/api-keys", response=list[ApiKeyResponse])
def list_api_keys(request: HttpRequest, project_slug: str):
    """List all API keys for a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    keys = ApiKeyService.list_keys(project)
    return [ApiKeyResponse.from_orm(k) for k in keys]


@router.delete("/{project_slug}/api-keys/{key_id}", response=MessageResponse)
def revoke_api_key(request: HttpRequest, project_slug: str, key_id: str):
    """Revoke a specific API key."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    success = ApiKeyService.revoke_key(project, key_id)
    if not success:
        return MessageResponse(message="API key not found or already revoked")
    return MessageResponse(message="API key revoked successfully")


# ── Team members & invitations ───────────────────────────────────────


@router.get("/{project_slug}/members", response=MembersListResponse)
def list_members(request: HttpRequest, project_slug: str):
    """List project members + (for owner/admin) pending invitations."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return MembershipService.list_members(user, project)


@router.post("/{project_slug}/members/invite", response={201: InvitationResponse})
def invite_member(request: HttpRequest, project_slug: str, data: InviteMemberRequest):
    """Invite someone to the project by email (owner/admin only)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    inv = MembershipService.invite_member(user, project, data.email, data.role)
    return 201, InvitationResponse(
        id=str(inv.id),
        email=inv.email,
        role=inv.role,
        expires_at=inv.expires_at,
        created_at=inv.created_at,
    )


@router.patch("/{project_slug}/members/{member_id}", response=MessageResponse)
def update_member(request: HttpRequest, project_slug: str, member_id: str, data: UpdateMemberRoleRequest):
    """Change a member's role (owner/admin only)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    MembershipService.update_member_role(user, project, member_id, data.role)
    return MessageResponse(message="Member role updated")


@router.delete("/{project_slug}/members/{member_id}", response=MessageResponse)
def remove_member(request: HttpRequest, project_slug: str, member_id: str):
    """Remove a member (owner/admin), or leave the project (self)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    MembershipService.remove_member(user, project, member_id)
    return MessageResponse(message="Member removed")


@router.delete("/{project_slug}/invitations/{invite_id}", response=MessageResponse)
def revoke_invitation(request: HttpRequest, project_slug: str, invite_id: str):
    """Revoke a pending invitation (owner/admin only)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    MembershipService.revoke_invitation(user, project, invite_id)
    return MessageResponse(message="Invitation revoked")


# ── Invitee inbox (notification bell + invite link) ──────────────────


@router.get("/invitations/pending", response=list[PendingInvitationResponse])
def list_pending_invitations(request: HttpRequest):
    """Pending invitations addressed to the logged-in user (powers the bell)."""
    user: User = request.auth
    return MembershipService.list_pending_for_user(user)


@router.post("/invitations/{invite_id}/accept", response=AcceptResultResponse)
def accept_invitation_by_id(request: HttpRequest, invite_id: str):
    """Accept a pending invitation by id (from the notification bell)."""
    user: User = request.auth
    project = MembershipService.accept_by_id(user, invite_id)
    return AcceptResultResponse(
        message=f"You've joined {project.name}",
        project_slug=project.slug,
        project_name=project.name,
    )


@router.post("/invitations/{invite_id}/decline", response=MessageResponse)
def decline_invitation_by_id(request: HttpRequest, invite_id: str):
    """Decline a pending invitation by id (from the notification bell)."""
    user: User = request.auth
    MembershipService.decline_by_id(user, invite_id)
    return MessageResponse(message="Invitation declined")


@router.post("/invitations/accept", response=AcceptResultResponse)
def accept_invitation(request: HttpRequest, data: AcceptInvitationRequest):
    """Accept an invitation by token (from the email invite link)."""
    user: User = request.auth
    project = MembershipService.accept_by_token(user, data.token)
    return AcceptResultResponse(
        message=f"You've joined {project.name}",
        project_slug=project.slug,
        project_name=project.name,
    )


@router.post("/invitations/decline", response=MessageResponse)
def decline_invitation(request: HttpRequest, data: AcceptInvitationRequest):
    """Decline an invitation by token (from the email invite link)."""
    user: User = request.auth
    MembershipService.decline_by_token(user, data.token)
    return MessageResponse(message="Invitation declined")


# ── Project-level Analytics (aggregated) ─────────────────────────────


@router.get("/{project_slug}/analytics/summary", response=dict)
def get_analytics_summary(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    consumer: str = None,
    filter: str = None,
):
    """
    Get aggregated analytics summary for a project.
    Optionally filter by a specific app within the project.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    return AnalyticsService.get_project_summary(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        consumer=consumer,
        filter=filter,
    )


@router.get("/{project_slug}/analytics/timeseries", response=list[AnalyticsTimeseriesPointResponse])
def get_analytics_timeseries(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    timezone: str = None,
    consumer: str = None,
    filter: str = None,
):
    """
    Get time-series analytics for a project.
    Optionally filter by a specific app within the project.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    bucket_timezone = (
        UserService.normalize_timezone(timezone)
        if timezone
        else UserService.get_timezone(user)
    )

    return AnalyticsService.get_project_timeseries(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        timezone_name=bucket_timezone,
        consumer=consumer,
        filter=filter,
    )


@router.get("/{project_slug}/analytics/endpoints", response=dict)
def get_endpoint_stats(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    methods: str = None,
    status_classes: str = None,
    status_codes: str = None,
    q: str = None,
    consumer: str = None,
    filter: str = None,
    sort_by: str = "total_requests",
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 25,
):
    """
    Get endpoint statistics aggregated across a project with pagination.
    Optionally filter by specific apps within the project.

    Query parameters:
    - app_slugs: Comma-separated app slugs to filter
    - environment: Filter by environment name
    - since/until: Time range
    - methods: Comma-separated HTTP methods (e.g., "GET,POST")
    - status_classes: Comma-separated status classes (e.g., "2xx,4xx")
    - status_codes: Comma-separated status codes (e.g., "200,404")
    - q: Search query for path or method
    - sort_by: Field to sort by (endpoint, total_requests, error_rate, avg_response_time_ms, p95_response_time_ms)
    - sort_dir: Sort direction (asc or desc)
    - page: Page number (1-indexed)
    - page_size: Items per page

    Returns:
    {
        "items": [...],
        "total_count": int
    }
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    method_list = None
    if methods:
        method_list = [m.strip().upper() for m in methods.split(",") if m.strip()]

    status_class_list = None
    if status_classes:
        status_class_list = [sc.strip() for sc in status_classes.split(",") if sc.strip()]

    status_code_list = None
    if status_codes:
        status_code_list = [int(sc.strip()) for sc in status_codes.split(",") if sc.strip().isdigit()]

    return AnalyticsService.get_project_endpoint_stats(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        methods=method_list,
        status_classes=status_class_list,
        status_codes=status_code_list,
        search_query=q,
        consumer=consumer,
        filter=filter,
        sort_by=sort_by,
        sort_dir=sort_dir,
        page=page,
        page_size=page_size,
    )


# ── Ask APILens (NL → filter DSL) ─────────────────────────────────────


@router.post("/{project_slug}/analytics/ask", response=dict)
def ask_project(request: HttpRequest, project_slug: str, data: dict):
    """Translate a natural-language question into a validated filter string."""
    from apps.ai.nl_filter import translate

    user: User = request.auth
    ProjectService.get_project_by_slug(user, project_slug)
    return translate(str(data.get("question") or ""))


# ── AI Investigator ────────────────────────────────────────────────────


@router.post("/{project_slug}/analytics/investigations", response=dict)
def start_investigation(request: HttpRequest, project_slug: str, data: dict):
    """Start (or return the in-flight) AI investigation for an error issue."""
    from apps.ai.services import InvestigationService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    inv = InvestigationService.start(project, str(data.get("fingerprint") or ""), user)
    return InvestigationService.serialize(inv)


@router.get("/{project_slug}/analytics/investigations", response=dict)
def get_investigation(request: HttpRequest, project_slug: str, fingerprint: str):
    """Latest investigation for an issue (poll target while one is running)."""
    from apps.ai.services import InvestigationService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return InvestigationService.serialize(InvestigationService.get_latest(project, fingerprint))


# ── Narrator: postmortems, digests, surface changelog (Phase 6) ───────


@router.post("/{project_slug}/analytics/postmortem", response=dict)
def start_postmortem(request: HttpRequest, project_slug: str, data: dict):
    """Draft (or return the in-flight) incident postmortem for an issue."""
    from apps.ai.services import PostmortemService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    pm = PostmortemService.start(project, str(data.get("fingerprint") or ""), user)
    return PostmortemService.serialize(pm)


@router.get("/{project_slug}/analytics/postmortem", response=dict)
def get_postmortem(request: HttpRequest, project_slug: str, fingerprint: str):
    """Latest postmortem for an issue (poll while it drafts)."""
    from apps.ai.services import PostmortemService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return PostmortemService.serialize(PostmortemService.get_latest(project, fingerprint))


@router.get("/{project_slug}/analytics/digest-preview", response=dict)
def digest_preview(request: HttpRequest, project_slug: str, days: int = 7):
    """Render the digest for the last `days` without sending it."""
    from apps.ai.narrator import assemble_digest, narrate_digest, render_digest_markdown

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    digest = assemble_digest(project, days=max(1, min(int(days), 30)))
    return {
        "narrative": narrate_digest(digest),
        "markdown": render_digest_markdown(digest),
        "surface": digest["surface"],
    }


@router.get("/{project_slug}/digest", response=dict)
def get_digest_config(request: HttpRequest, project_slug: str):
    from apps.alerts.models import DigestSubscription

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    sub = DigestSubscription.objects.filter(project=project).prefetch_related("channels").first()
    if sub is None:
        return {"exists": False}
    return {
        "exists": True,
        "is_active": sub.is_active,
        "cadence": sub.cadence,
        "weekday": sub.weekday,
        "channel_ids": [str(c.id) for c in sub.channels.all()],
        "last_sent_at": sub.last_sent_at.isoformat() if sub.last_sent_at else None,
    }


@router.put("/{project_slug}/digest", response=dict)
def set_digest_config(request: HttpRequest, project_slug: str, data: dict):
    """Create or update the project's digest subscription."""
    from apps.alerts.models import AlertChannel, DigestSubscription

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    sub, _ = DigestSubscription.objects.get_or_create(project=project, defaults={"created_by": user})
    sub.is_active = bool(data.get("is_active", True))
    sub.cadence = "daily" if str(data.get("cadence")) == "daily" else "weekly"
    sub.weekday = max(0, min(int(data.get("weekday") or 0), 6))
    sub.save()
    if data.get("channel_ids") is not None:
        sub.channels.set(
            AlertChannel.objects.filter(project=project, id__in=[str(c) for c in data["channel_ids"]])
        )
    return {"message": "Digest updated"}


@router.post("/{project_slug}/digest/send", response=dict)
def send_digest_now(request: HttpRequest, project_slug: str):
    """Send the digest immediately through its channels (the 'send now' button)."""
    from apps.alerts.digest import build_and_send
    from apps.alerts.models import DigestSubscription
    from core.exceptions.base import ValidationError

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    sub = DigestSubscription.objects.filter(project=project).first()
    if sub is None or not sub.channels.exists():
        raise ValidationError("Configure the digest with at least one channel first")
    result = build_and_send(sub, force=True)
    return {"delivery": result["delivery"], "narrative": result["narrative"]}


# ── Sentinel: alert channels, rules, events (Phase 5) ─────────────────


@router.get("/{project_slug}/alerts", response=dict)
def list_alerts_config(request: HttpRequest, project_slug: str):
    """Channels + rules + recent events for the Alerts settings tab."""
    from apps.alerts.models import AlertChannel, AlertEvent, AlertRule
    from apps.alerts.services import serialize_channel, serialize_event, serialize_rule

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return {
        "channels": [serialize_channel(c) for c in AlertChannel.objects.filter(project=project)],
        "rules": [
            serialize_rule(r)
            for r in AlertRule.objects.filter(project=project).prefetch_related("channels")
        ],
        "events": [
            serialize_event(e)
            for e in AlertEvent.objects.filter(project=project)[:30]
        ],
    }


@router.post("/{project_slug}/alerts/channels", response=dict)
def create_alert_channel(request: HttpRequest, project_slug: str, data: dict):
    from apps.alerts.services import AlertService, serialize_channel

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    return serialize_channel(AlertService.create_channel(project, user, data))


@router.post("/{project_slug}/alerts/channels/{channel_id}/test", response=dict)
def test_alert_channel(request: HttpRequest, project_slug: str, channel_id: str):
    """Send a test notification through one channel."""
    from apps.alerts.models import AlertChannel
    from apps.alerts.notify import deliver
    from core.exceptions.base import NotFoundError

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    channel = AlertChannel.objects.filter(project=project, id=channel_id).first()
    if channel is None:
        raise NotFoundError("Channel not found")
    ok, detail = deliver(
        channel,
        {
            "transition": "firing",
            "rule_name": "Test alert",
            "rule_kind": "test",
            "project_slug": project.slug,
            "summary": "This is a test notification from APILens — your channel works.",
            "targets": [{"target": "test", "value": 1, "threshold": 0}],
            "link": "",
            "timestamp": "",
        },
    )
    return {"ok": ok, "detail": detail}


@router.delete("/{project_slug}/alerts/channels/{channel_id}", response=dict)
def delete_alert_channel(request: HttpRequest, project_slug: str, channel_id: str):
    from apps.alerts.services import AlertService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    AlertService.delete_channel(project, channel_id)
    return {"message": "Channel deleted"}


@router.post("/{project_slug}/alerts/rules", response=dict)
def create_alert_rule(request: HttpRequest, project_slug: str, data: dict):
    from apps.alerts.services import AlertService, serialize_rule

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    return serialize_rule(AlertService.upsert_rule(project, user, data))


@router.patch("/{project_slug}/alerts/rules/{rule_id}", response=dict)
def update_alert_rule(request: HttpRequest, project_slug: str, rule_id: str, data: dict):
    from apps.alerts.models import AlertRule
    from apps.alerts.services import AlertService, serialize_rule
    from core.exceptions.base import NotFoundError

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    rule = AlertRule.objects.filter(project=project, id=rule_id).first()
    if rule is None:
        raise NotFoundError("Rule not found")
    return serialize_rule(AlertService.upsert_rule(project, user, data, rule=rule))


@router.delete("/{project_slug}/alerts/rules/{rule_id}", response=dict)
def delete_alert_rule(request: HttpRequest, project_slug: str, rule_id: str):
    from apps.alerts.services import AlertService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    AlertService.delete_rule(project, rule_id)
    return {"message": "Rule deleted"}


# ── Fix handoff + issue lifecycle (Phase 4) ───────────────────────────


@router.get("/{project_slug}/analytics/fix-brief", response=dict)
def get_fix_brief(request: HttpRequest, project_slug: str, fingerprint: str):
    """The coding-agent fix brief for an error issue, plus past handoffs."""
    from apps.ai.fix_brief import build_fix_brief
    from apps.integrations.models import FixHandoff

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    brief = build_fix_brief(project, (fingerprint or "").strip())
    brief["handoffs"] = [
        {
            "kind": h.kind,
            "external_url": h.external_url,
            "repository": h.repository.full_name if h.repository_id else "",
            "created_at": h.created_at.isoformat(),
        }
        for h in FixHandoff.objects.filter(project=project, fingerprint=fingerprint)
        .select_related("repository")[:5]
    ]
    return brief


@router.post("/{project_slug}/analytics/fix-handoff", response=dict)
def create_fix_handoff(request: HttpRequest, project_slug: str, data: dict):
    """Hand an issue to a coding agent.

    kind=github_issue creates a real issue in the app's mapped repository
    (assign it to Copilot on GitHub to trigger the coding agent); clipboard
    and cursor record the handoff and return the brief for the client to
    deliver."""
    from apps.ai.fix_brief import build_fix_brief
    from apps.integrations import github_client
    from apps.integrations.models import FixHandoff, Repository
    from core.exceptions.base import ValidationError

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    fingerprint = str(data.get("fingerprint") or "").strip()
    kind = str(data.get("kind") or "").strip()
    if kind not in FixHandoff.Kind.values:
        raise ValidationError(f"kind must be one of {list(FixHandoff.Kind.values)}")

    brief = build_fix_brief(project, fingerprint)
    repo = None
    external_url = ""
    if kind == FixHandoff.Kind.GITHUB_ISSUE:
        if not brief.get("repository_id"):
            raise ValidationError(
                "No repository mapped for this issue's app — link a repo and add a code mapping first"
            )
        repo = Repository.objects.select_related("installation").filter(
            project=project, id=brief["repository_id"]
        ).first()
        if repo is None:
            raise ValidationError("Mapped repository is no longer linked")
        try:
            issue = github_client.create_issue(
                repo.installation.installation_id,
                repo.full_name,
                title=brief["title"],
                body=brief["markdown"],
                labels=["apilens", "bug"],
                base_url=repo.installation.base_url,
            )
        except github_client.GitHubApiError as exc:
            if exc.status_code == 403:
                raise ValidationError(
                    "GitHub refused issue creation — grant the APILens app Issues: Read & Write and re-accept permissions"
                ) from exc
            raise ValidationError(f"GitHub issue creation failed: {exc.detail}") from exc
        external_url = str(issue.get("html_url") or "")

    handoff = FixHandoff.objects.create(
        project=project,
        fingerprint=fingerprint,
        kind=kind,
        repository=repo,
        external_url=external_url,
        created_by=user,
    )
    return {
        "kind": handoff.kind,
        "external_url": handoff.external_url,
        "repository": repo.full_name if repo else "",
        "title": brief["title"],
        "markdown": brief["markdown"],
    }


@router.patch("/{project_slug}/analytics/error-issues", response=dict)
def update_error_issue(request: HttpRequest, project_slug: str, data: dict):
    """Resolve / ignore / reopen an error issue. Recurrence after resolve
    auto-flips it to `regressed` at ingest."""
    from apps.projects.services import ErrorIssueService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="write")
    issue = ErrorIssueService.set_status(
        project,
        str(data.get("fingerprint") or ""),
        str(data.get("status") or ""),
        str(data.get("release") or ""),
    )
    return {"fingerprint": issue.fingerprint, "status": issue.status}


@router.get("/{project_slug}/analytics/issue-verification", response=dict)
def get_issue_verification(request: HttpRequest, project_slug: str, fingerprint: str):
    """Post-deploy verification: resolved + deployed + no recurrence = verified."""
    from apps.projects.services import ErrorIssueService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return ErrorIssueService.get_verification(project, fingerprint)


# ── GitHub integration (Code Link) ────────────────────────────────────


@router.get("/{project_slug}/integrations/github", response=dict)
def github_integration_status(request: HttpRequest, project_slug: str):
    """Installations, linked repos, and code mappings for the settings UI."""
    from apps.integrations.services import GitHubIntegrationService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return GitHubIntegrationService.get_status(project)


@router.post("/{project_slug}/integrations/github/install-url", response=dict)
def github_install_url(request: HttpRequest, project_slug: str):
    """Signed install URL for the GitHub App (state ties the callback to this
    project + user)."""
    from apps.integrations.services import GitHubIntegrationService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    return GitHubIntegrationService.build_install_url(project, user)


@router.delete("/{project_slug}/integrations/github/{install_id}", response=dict)
def github_remove_installation(request: HttpRequest, project_slug: str, install_id: str):
    from apps.integrations.services import GitHubIntegrationService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    GitHubIntegrationService.remove_installation(project, install_id)
    return {"message": "GitHub installation removed"}


@router.get("/{project_slug}/integrations/github/repos", response=list[dict])
def github_available_repos(request: HttpRequest, project_slug: str):
    """Repos reachable through the project's installations (the link picker)."""
    from apps.integrations.services import GitHubIntegrationService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    return GitHubIntegrationService.list_available_repos(project)


@router.post("/{project_slug}/integrations/github/repos", response=dict)
def github_link_repo(request: HttpRequest, project_slug: str, data: dict):
    from apps.integrations.services import GitHubIntegrationService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    repo = GitHubIntegrationService.link_repository(
        project,
        str(data.get("installation_id") or ""),
        int(data.get("external_id") or 0),
        str(data.get("full_name") or ""),
        str(data.get("default_branch") or "main"),
        bool(data.get("private", True)),
    )
    return {"id": str(repo.id), "full_name": repo.full_name}


@router.delete("/{project_slug}/integrations/github/repos/{repo_id}", response=dict)
def github_unlink_repo(request: HttpRequest, project_slug: str, repo_id: str):
    from apps.integrations.services import GitHubIntegrationService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    GitHubIntegrationService.unlink_repository(project, repo_id)
    return {"message": "Repository unlinked"}


@router.post("/{project_slug}/apps/{app_slug}/code-mappings", response=dict)
def create_code_mapping(request: HttpRequest, project_slug: str, app_slug: str, data: dict):
    """App-level path mapping (monorepo: many apps → one repo with different
    source roots; polyrepo: one repo per app)."""
    from apps.integrations.models import Repository
    from apps.integrations.services import CodeMappingService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    app = AppService.get_app_by_slug(project, app_slug)
    repo = Repository.objects.filter(project=project, id=str(data.get("repository_id") or "")).first()
    if repo is None:
        from core.exceptions.base import NotFoundError

        raise NotFoundError("Repository not linked to this project")
    mapping = CodeMappingService.create(
        app,
        repo,
        str(data.get("stack_trace_root") or ""),
        str(data.get("source_root") or ""),
        str(data.get("branch") or ""),
    )
    return {"id": str(mapping.id)}


@router.delete("/{project_slug}/apps/{app_slug}/code-mappings/{mapping_id}", response=dict)
def delete_code_mapping(request: HttpRequest, project_slug: str, app_slug: str, mapping_id: str):
    from apps.integrations.services import CodeMappingService

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug, action="admin")
    app = AppService.get_app_by_slug(project, app_slug)
    CodeMappingService.delete(app, mapping_id)
    return {"message": "Code mapping deleted"}


@router.get("/{project_slug}/analytics/suspect-commits", response=dict)
def get_suspect_commits(
    request: HttpRequest,
    project_slug: str,
    fingerprint: str = None,
    method: str = None,
    path: str = None,
    message: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
):
    """Suspect commits + stack-frame source links for one error issue.

    Scope by fingerprint (preferred) or the legacy method/path/message tuple;
    uses the issue's latest event (stack + stamped running commit)."""
    from apps.integrations.services import SuspectCommitService
    from apps.projects.models import ErrorIssue

    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    events = DataQueryService.get_project_error_events(
        project_id=str(project.id),
        environment=environment,
        since=since,
        until=until,
        method=method,
        path=path,
        message=message,
        fingerprint=fingerprint,
        limit=1,
    )
    if not events:
        return {"suspect_commits": [], "frame_links": [], "reason": "no_events"}
    event = events[0]

    app_id = None
    fp = (fingerprint or event.get("fingerprint") or "").strip()
    if fp:
        issue = ErrorIssue.objects.filter(project=project, fingerprint=fp).first()
        if issue is not None:
            app_id = issue.app_id
    if app_id is None:
        # Fallback: a single-app project needs no issue entity to resolve.
        app_ids = list(App.objects.filter(project=project, is_active=True).values_list("id", flat=True))
        app_id = app_ids[0] if len(app_ids) == 1 else None

    return SuspectCommitService.for_event(
        project,
        app_id,
        str(event.get("payload") or ""),
        str(event.get("commit_sha") or ""),
        event.get("timestamp"),
    )


@router.get("/{project_slug}/deploys", response=list[dict])
def list_project_deploys(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 100,
):
    """Deploy/release events in a time window (chart markers, release timeline)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids = []
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        for slug in slugs:
            app = AppService.get_app_by_slug(project, slug)
            app_ids.append(str(app.id))

    return DeployService.list_deploys(
        project_id=str(project.id),
        app_ids=app_ids if app_ids else None,
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{project_slug}/analytics/environments", response=dict)
def get_environments(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
):
    """
    Get list of environments with data for a project.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids = []
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        for slug in slugs:
            app = AppService.get_app_by_slug(project, slug)
            app_ids.append(str(app.id))

    environments = AnalyticsService.get_project_environments(
        project_id=str(project.id),
        app_ids=app_ids if app_ids else None,
    )

    return {"environments": environments}


@router.get("/{project_slug}/analytics/consumers", response=list[dict])
def get_project_consumers(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 200,
):
    """
    List the consumers seen across a project, ranked by request volume.
    Powers the consumer filter dropdown on the Request logs / Traffic pages.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    return AnalyticsService.get_project_consumers(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{project_slug}/analytics/filter-values", response=list[dict])
def get_filter_values(
    request: HttpRequest,
    project_slug: str,
    field: str,
    q: str = None,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 20,
):
    """
    Typeahead source for the filter bar. Returns distinct values of `field`
    (path/consumer/ip/ua/method) matching `q`, ranked by frequency. Optimised
    for autocomplete — term-filtered + small LIMIT, never the full cardinality.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    return AnalyticsService.get_filter_values(
        project_id=str(project.id),
        field=field,
        q=q,
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{project_slug}/analytics/consumer-stats", response=list[dict])
def get_project_consumer_stats(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    search: str = None,
    filter: str = None,
    limit: int = 200,
):
    """
    Rich per-consumer stats across a project (requests, error rate, avg
    response, last seen), filterable by app/env/time, a name/id search, and
    the shared rich `filter` query. Powers the dedicated Consumers page.
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids: list[str] | None = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    return AnalyticsService.get_project_consumer_stats(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        search=search,
        filter=filter,
        limit=limit,
    )


# ── Project-level Endpoint Detail ────────────────────────────────────

def _resolve_endpoint_app_ids(project, app_slugs: str | None) -> list[str] | None:
    """Resolve a comma-separated list of app slugs to app ids within a project."""
    if not app_slugs:
        return None
    slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
    if not slugs:
        return None
    apps = AppService.get_apps_by_slugs(project, slugs)
    return [str(app.id) for app in apps]


@router.get("/{project_slug}/analytics/endpoint-detail", response=dict)
def get_project_endpoint_detail(
    request: HttpRequest,
    project_slug: str,
    method: str,
    path: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    filter: str = None,
    threshold_ms: float = 500.0,
):
    """Get an aggregated summary for a single endpoint across a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return AnalyticsService.get_project_endpoint_detail(
        project_id=str(project.id),
        method=method,
        path=path,
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        filter=filter,
        threshold_ms=threshold_ms,
    )


@router.get("/{project_slug}/analytics/endpoint-timeseries", response=list[dict])
def get_project_endpoint_timeseries(
    request: HttpRequest,
    project_slug: str,
    method: str,
    path: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    filter: str = None,
    timezone: str = None,
):
    """Get hourly time-series for a single endpoint across a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    bucket_timezone = (
        UserService.normalize_timezone(timezone)
        if timezone
        else UserService.get_timezone(user)
    )
    return AnalyticsService.get_project_endpoint_timeseries(
        project_id=str(project.id),
        method=method,
        path=path,
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        filter=filter,
        timezone_name=bucket_timezone,
    )


@router.get("/{project_slug}/analytics/endpoint-consumers", response=list[dict])
def get_project_endpoint_consumers(
    request: HttpRequest,
    project_slug: str,
    method: str,
    path: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    filter: str = None,
    limit: int = 10,
):
    """Get the top consumers for a single endpoint across a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return AnalyticsService.get_project_endpoint_consumers(
        project_id=str(project.id),
        method=method,
        path=path,
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        filter=filter,
        limit=limit,
    )


@router.get("/{project_slug}/analytics/endpoint-status-codes", response=list[dict])
def get_project_endpoint_status_codes(
    request: HttpRequest,
    project_slug: str,
    method: str,
    path: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    filter: str = None,
    limit: int = 20,
):
    """Get the status-code breakdown for a single endpoint across a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return AnalyticsService.get_project_endpoint_status_codes(
        project_id=str(project.id),
        method=method,
        path=path,
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        filter=filter,
        limit=limit,
    )


@router.get("/{project_slug}/analytics/endpoint-requests", response=list[dict])
def get_project_endpoint_requests(
    request: HttpRequest,
    project_slug: str,
    method: str,
    path: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    filter: str = None,
    limit: int = 20,
    errors_only: bool = False,
):
    """Get the most recent requests for a single endpoint across a project."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return AnalyticsService.get_project_endpoint_requests(
        project_id=str(project.id),
        method=method,
        path=path,
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        filter=filter,
        limit=limit,
        errors_only=errors_only,
    )


@router.get("/{project_slug}/analytics/endpoint-histograms", response=dict)
def get_project_endpoint_histograms(
    request: HttpRequest,
    project_slug: str,
    method: str,
    path: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    filter: str = None,
    bins: int = 30,
):
    """Get response-time and response-size histograms for a single endpoint."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return AnalyticsService.get_project_endpoint_histograms(
        project_id=str(project.id),
        method=method,
        path=path,
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        filter=filter,
        bins=bins,
    )


# ── Project-level Errors (exception-centric views over api_logs) ─────

@router.get("/{project_slug}/analytics/error-summary", response=dict)
def get_project_error_summary(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    filter: str = None,
):
    """Overview tiles for the Errors page: 4xx/5xx counts + unique issues."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return DataQueryService.get_project_error_summary(
        project_id=str(project.id),
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        filter=filter,
    )


@router.get("/{project_slug}/analytics/error-issues", response=list[dict])
def get_project_error_issues(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    search: str = None,
    filter: str = None,
    limit: int = 100,
):
    """Errors grouped into issues by (method, path, status, message)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return DataQueryService.get_project_error_issues(
        project_id=str(project.id),
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        search=search,
        filter=filter,
        limit=limit,
    )


@router.get("/{project_slug}/analytics/error-events", response=list[dict])
def get_project_error_events(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    method: str = None,
    path: str = None,
    message: str = None,
    trace_id: str = None,
    fingerprint: str = None,
    filter: str = None,
    limit: int = 50,
):
    """Individual ERROR events (flat feed, or a single issue's occurrences)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return DataQueryService.get_project_error_events(
        project_id=str(project.id),
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        method=method,
        path=path,
        message=message,
        trace_id=trace_id,
        fingerprint=fingerprint,
        filter=filter,
        limit=limit,
    )


@router.get("/{project_slug}/analytics/error-status-groups", response=list[dict])
def get_project_error_status_groups(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    search: str = None,
    filter: str = None,
    limit: int = 200,
):
    """Errors grouped by (status_code, method, path) — the errors table (incl. 4xx)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    return DataQueryService.get_project_error_status_groups(
        project_id=str(project.id),
        app_ids=_resolve_endpoint_app_ids(project, app_slugs),
        environment=environment,
        since=since,
        until=until,
        search=search,
        filter=filter,
        limit=limit,
    )


# ── Project-level Data Query (raw telemetry access) ──────────────────

@router.get("/{project_slug}/data/logs", response=LogsQueryResponse)
def query_project_logs(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    levels: str = None,
    search: str = None,
    loggers: str = None,
    trace_id: str = None,
    page: int = 1,
    page_size: int = 50,
):
    """
    Query raw log data across all apps in a project (or specific apps).

    Filters:
    - app_slugs: Comma-separated app slugs (e.g., "api,worker")
    - environment: Filter by environment name
    - levels: Comma-separated log levels (e.g., "ERROR,WARNING")
    - search: Search in message, logger_name, or attributes
    - loggers: Comma-separated logger names
    - trace_id: Only logs correlated with this W3C trace id
    - since/until: ISO8601 timestamps for time range
    - page/page_size: Pagination controls
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    level_list = None
    if levels:
        level_list = [l.strip().upper() for l in levels.split(",") if l.strip()]

    logger_list = None
    if loggers:
        logger_list = [lg.strip() for lg in loggers.split(",") if lg.strip()]

    result = DataQueryService.get_project_logs(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        levels=level_list,
        search=search,
        logger_filters=logger_list,
        trace_id=trace_id,
        page=page,
        page_size=page_size,
    )

    return LogsQueryResponse(**result)


@router.get("/{project_slug}/data/trace", response=TraceQueryResponse)
def query_trace_spans(
    request: HttpRequest,
    project_slug: str,
    trace_id: str,
):
    """All spans of one distributed trace (request-detail waterfall)."""
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)
    result = DataQueryService.get_trace_spans(
        project_id=str(project.id),
        trace_id=trace_id,
    )
    return TraceQueryResponse(**result)


@router.get("/{project_slug}/data/requests", response=RequestsQueryResponse)
def query_project_requests(
    request: HttpRequest,
    project_slug: str,
    app_slugs: str = None,
    environment: str = None,
    since: str = None,
    until: str = None,
    methods: str = None,
    status_codes: str = None,
    min_response_time: float = None,
    max_response_time: float = None,
    path_filter: str = None,
    consumer: str = None,
    filter: str = None,
    page: int = 1,
    page_size: int = 50,
):
    """
    Query raw API request data across all apps in a project (or specific apps).

    `filter` is a canonical rich-filter string (field:op:value;… — see
    apps.projects.filters) applied on top of the discrete params below.

    Filters:
    - app_slugs: Comma-separated app slugs (e.g., "api,worker")
    - environment: Filter by environment name
    - methods: Comma-separated HTTP methods (e.g., "GET,POST")
    - status_codes: Comma-separated status codes (e.g., "200,201,404")
    - min_response_time/max_response_time: Response time range in ms
    - path_filter: Path pattern (use * for wildcards, e.g., "/api/users/*")
    - since/until: ISO8601 timestamps for time range
    - page/page_size: Pagination controls
    """
    user: User = request.auth
    project = ProjectService.get_project_by_slug(user, project_slug)

    app_ids = None
    if app_slugs:
        slugs = [s.strip() for s in app_slugs.split(",") if s.strip()]
        if slugs:
            apps = AppService.get_apps_by_slugs(project, slugs)
            app_ids = [str(app.id) for app in apps]

    method_list = None
    if methods:
        method_list = [m.strip().upper() for m in methods.split(",") if m.strip()]

    status_list = None
    if status_codes:
        status_list = [int(s.strip()) for s in status_codes.split(",") if s.strip().isdigit()]

    result = DataQueryService.get_project_requests(
        project_id=str(project.id),
        app_ids=app_ids,
        environment=environment,
        since=since,
        until=until,
        methods=method_list,
        status_codes=status_list,
        min_response_time=min_response_time,
        max_response_time=max_response_time,
        path_filter=path_filter,
        consumer=consumer,
        filter=filter,
        page=page,
        page_size=page_size,
    )

    return RequestsQueryResponse(**result)
