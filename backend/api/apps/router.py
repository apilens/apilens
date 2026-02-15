from django.db.models import Count, Q
from django.http import HttpRequest
from ninja import File
from ninja.files import UploadedFile
from ninja import Router

from apps.auth.services import ApiKeyService
from apps.projects.services import AppService, EnvironmentService
from apps.users.models import User
from core.auth.authentication import jwt_auth
from core.exceptions.base import ValidationError

from .schemas import (
    AppListResponse,
    AppResponse,
    AnalyticsSummaryResponse,
    AnalyticsTimeseriesPointResponse,
    RelatedApiResponse,
    EndpointDetailResponse,
    EndpointTimeseriesPointResponse,
    EndpointConsumerResponse,
    EndpointStatusCodeResponse,
    EndpointPayloadSampleResponse,
    CreateApiKeyRequest,
    CreateAppRequest,
    UpdateAppRequest,
    EnvironmentResponse,
    EndpointStatsListResponse,
    EndpointOptionResponse,
    EnvironmentOptionResponse,
    AppIconResponse,
    ConsumerStatsResponse,
    ApiKeyResponse,
    CreateApiKeyResponse,
    MessageResponse,
    _build_app_icon_url,
)

router = Router(auth=[jwt_auth])


@router.post("/", response={201: AppResponse})
def create_app(request: HttpRequest, data: CreateAppRequest):
    user: User = request.auth
    app = AppService.create_app(user, data.name, data.description, data.framework)
    return 201, AppResponse(
        id=app.id,
        name=app.name,
        slug=app.slug,
        icon_url=_build_app_icon_url(app),
        description=app.description,
        framework=app.framework,
        created_at=app.created_at,
        updated_at=app.updated_at,
    )


@router.get("/", response=list[AppListResponse])
def list_apps(request: HttpRequest):
    user: User = request.auth
    apps = AppService.list_apps(user)

    # Annotate with active key count
    from apps.projects.models import App
    app_ids = [a.id for a in apps]
    counts = dict(
        App.objects.filter(id__in=app_ids)
        .annotate(
            key_count=Count(
                "api_keys",
                filter=Q(api_keys__is_revoked=False),
            )
        )
        .values_list("id", "key_count")
    )

    return [
        AppListResponse(
            id=a.id,
            name=a.name,
            slug=a.slug,
            icon_url=_build_app_icon_url(a),
            description=a.description,
            framework=a.framework,
            api_key_count=counts.get(a.id, 0),
            created_at=a.created_at,
        )
        for a in apps
    ]


@router.get("/{app_slug}", response=AppResponse)
def get_app(request: HttpRequest, app_slug: str):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)
    return AppResponse(
        id=app.id,
        name=app.name,
        slug=app.slug,
        icon_url=_build_app_icon_url(app),
        description=app.description,
        framework=app.framework,
        created_at=app.created_at,
        updated_at=app.updated_at,
    )


@router.patch("/{app_slug}", response=AppResponse)
def update_app(request: HttpRequest, app_slug: str, data: UpdateAppRequest):
    user: User = request.auth
    app = AppService.update_app(user, app_slug, data.name, data.description, data.framework)
    return AppResponse(
        id=app.id,
        name=app.name,
        slug=app.slug,
        icon_url=_build_app_icon_url(app),
        description=app.description,
        framework=app.framework,
        created_at=app.created_at,
        updated_at=app.updated_at,
    )


@router.delete("/{app_slug}", response=MessageResponse)
def delete_app(request: HttpRequest, app_slug: str):
    user: User = request.auth
    AppService.delete_app(user, app_slug)
    return {"message": "App deleted"}


@router.post("/{app_slug}/icon", response=AppIconResponse)
def upload_app_icon(request: HttpRequest, app_slug: str, file: UploadedFile = File(...)):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)
    app = AppService.update_icon(app, file)
    return AppIconResponse(
        icon_url=_build_app_icon_url(app),
        message="App icon updated",
    )


@router.delete("/{app_slug}/icon", response=MessageResponse)
def remove_app_icon(request: HttpRequest, app_slug: str):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)
    AppService.remove_icon(app)
    return {"message": "App icon removed"}


# ── App-scoped API Keys ──────────────────────────────────────────────


@router.post("/{app_slug}/api-keys", response={201: CreateApiKeyResponse})
def create_api_key(request: HttpRequest, app_slug: str, data: CreateApiKeyRequest):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)
    if not data.name or not data.name.strip():
        raise ValidationError("API key name is required")
    raw_key, api_key = ApiKeyService.create_key(app, data.name.strip())
    return 201, CreateApiKeyResponse(
        key=raw_key,
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        created_at=api_key.created_at,
    )


@router.get("/{app_slug}/api-keys", response=list[ApiKeyResponse])
def list_api_keys(request: HttpRequest, app_slug: str):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)
    keys = ApiKeyService.list_keys(app)
    return [
        ApiKeyResponse(
            id=k.id,
            name=k.name,
            prefix=k.prefix,
            last_used_at=k.last_used_at,
            created_at=k.created_at,
        )
        for k in keys
    ]


@router.delete("/{app_slug}/api-keys/{key_id}", response=MessageResponse)
def revoke_api_key(request: HttpRequest, app_slug: str, key_id: str):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)
    from core.exceptions.base import NotFoundError
    revoked = ApiKeyService.revoke_key(app, key_id)
    if not revoked:
        raise NotFoundError("API key not found")
    return {"message": "API key revoked"}


# ── App-scoped Environments ──────────────────────────────────────────


@router.get("/{app_slug}/environments", response=list[EnvironmentResponse])
def list_environments(request: HttpRequest, app_slug: str):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)
    envs = EnvironmentService.list_environments(app)
    return [EnvironmentResponse.from_orm(e) for e in envs]


# ── App-scoped Endpoint Stats ────────────────────────────────────────


@router.get("/{app_slug}/endpoint-stats", response=EndpointStatsListResponse)
def get_endpoint_stats(
    request: HttpRequest,
    app_slug: str,
    environment: str = None,
    since: str = None,
    until: str = None,
    status_classes: str = None,
    status_codes: str = None,
    status_class: str = None,
    status_code: int = None,
    methods: str = None,
    paths: str = None,
    q: str = None,
    sort_by: str = "total_requests",
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 25,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import EndpointStatsService
    status_class_list: list[str] = []
    if status_classes:
        status_class_list.extend([s.strip() for s in status_classes.split(",") if s.strip()])
    if status_class:
        status_class_list.append(status_class)

    status_code_list: list[int] = []
    if status_codes:
        for raw in status_codes.split(","):
            raw = raw.strip()
            if not raw:
                continue
            try:
                status_code_list.append(int(raw))
            except ValueError:
                continue
    if status_code is not None:
        status_code_list.append(status_code)

    method_list: list[str] = []
    if methods:
        method_list = [m.strip().upper() for m in methods.split(",") if m.strip()]

    path_list: list[str] = []
    if paths:
        path_list = [p.strip() for p in paths.split(",") if p.strip()]

    endpoint_pairs: list[tuple[str, str]] = []
    for raw in request.GET.getlist("endpoint"):
        value = raw.strip()
        if not value:
            continue
        if " " in value:
            method, path = value.split(" ", 1)
            endpoint_pairs.append((method.strip().upper(), path.strip()))

    stats = EndpointStatsService.get_endpoint_stats(
        app_id=str(app.id),
        environment=environment,
        since=since,
        until=until,
        status_classes=status_class_list or None,
        status_codes=status_code_list or None,
        methods=method_list or None,
        paths=path_list or None,
        endpoint_pairs=endpoint_pairs or None,
        search=q,
        sort_by=sort_by,
        sort_dir=sort_dir,
        page=page,
        page_size=page_size,
    )
    return stats


@router.get("/{app_slug}/endpoint-options", response=list[EndpointOptionResponse])
def get_endpoint_options(
    request: HttpRequest,
    app_slug: str,
    environment: str = None,
    since: str = None,
    until: str = None,
    status_classes: str = None,
    status_codes: str = None,
    status_class: str = None,
    status_code: int = None,
    methods: str = None,
    q: str = None,
    limit: int = 500,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import EndpointStatsService
    status_class_list: list[str] = []
    if status_classes:
        status_class_list.extend([s.strip() for s in status_classes.split(",") if s.strip()])
    if status_class:
        status_class_list.append(status_class)

    status_code_list: list[int] = []
    if status_codes:
        for raw in status_codes.split(","):
            raw = raw.strip()
            if not raw:
                continue
            try:
                status_code_list.append(int(raw))
            except ValueError:
                continue
    if status_code is not None:
        status_code_list.append(status_code)

    method_list: list[str] = []
    if methods:
        method_list = [m.strip().upper() for m in methods.split(",") if m.strip()]

    return EndpointStatsService.get_endpoint_options(
        app_id=str(app.id),
        environment=environment,
        since=since,
        until=until,
        status_classes=status_class_list or None,
        status_codes=status_code_list or None,
        methods=method_list or None,
        search=q,
        limit=limit,
    )


@router.get("/{app_slug}/environment-options", response=list[EnvironmentOptionResponse])
def get_environment_options(
    request: HttpRequest,
    app_slug: str,
    since: str = None,
    until: str = None,
    limit: int = 50,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import EndpointStatsService
    return EndpointStatsService.get_environment_options(
        app_id=str(app.id),
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{app_slug}/consumers", response=list[ConsumerStatsResponse])
def get_consumer_stats(
    request: HttpRequest,
    app_slug: str,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 20,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import ConsumerStatsService
    return ConsumerStatsService.get_consumer_stats(
        app_id=str(app.id),
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{app_slug}/analytics/summary", response=AnalyticsSummaryResponse)
def get_analytics_summary(
    request: HttpRequest,
    app_slug: str,
    environment: str = None,
    since: str = None,
    until: str = None,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import AnalyticsService
    return AnalyticsService.get_summary(
        app_id=str(app.id),
        environment=environment,
        since=since,
        until=until,
    )


@router.get("/{app_slug}/analytics/timeseries", response=list[AnalyticsTimeseriesPointResponse])
def get_analytics_timeseries(
    request: HttpRequest,
    app_slug: str,
    environment: str = None,
    since: str = None,
    until: str = None,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import AnalyticsService
    return AnalyticsService.get_timeseries(
        app_id=str(app.id),
        environment=environment,
        since=since,
        until=until,
    )


@router.get("/{app_slug}/analytics/related-apis", response=list[RelatedApiResponse])
def get_analytics_related_apis(
    request: HttpRequest,
    app_slug: str,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 20,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import AnalyticsService
    return AnalyticsService.get_related_apis(
        app_id=str(app.id),
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{app_slug}/analytics/endpoint-detail", response=EndpointDetailResponse)
def get_analytics_endpoint_detail(
    request: HttpRequest,
    app_slug: str,
    method: str,
    path: str,
    environment: str = None,
    since: str = None,
    until: str = None,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import AnalyticsService
    return AnalyticsService.get_endpoint_detail(
        app_id=str(app.id),
        method=method,
        path=path,
        environment=environment,
        since=since,
        until=until,
    )


@router.get("/{app_slug}/analytics/endpoint-timeseries", response=list[EndpointTimeseriesPointResponse])
def get_analytics_endpoint_timeseries(
    request: HttpRequest,
    app_slug: str,
    method: str,
    path: str,
    environment: str = None,
    since: str = None,
    until: str = None,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import AnalyticsService
    return AnalyticsService.get_endpoint_timeseries(
        app_id=str(app.id),
        method=method,
        path=path,
        environment=environment,
        since=since,
        until=until,
    )


@router.get("/{app_slug}/analytics/endpoint-consumers", response=list[EndpointConsumerResponse])
def get_analytics_endpoint_consumers(
    request: HttpRequest,
    app_slug: str,
    method: str,
    path: str,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 10,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import AnalyticsService
    return AnalyticsService.get_endpoint_consumers(
        app_id=str(app.id),
        method=method,
        path=path,
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{app_slug}/analytics/endpoint-status-codes", response=list[EndpointStatusCodeResponse])
def get_analytics_endpoint_status_codes(
    request: HttpRequest,
    app_slug: str,
    method: str,
    path: str,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 20,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import AnalyticsService
    return AnalyticsService.get_endpoint_status_codes(
        app_id=str(app.id),
        method=method,
        path=path,
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )


@router.get("/{app_slug}/analytics/endpoint-payloads", response=list[EndpointPayloadSampleResponse])
def get_analytics_endpoint_payloads(
    request: HttpRequest,
    app_slug: str,
    method: str,
    path: str,
    environment: str = None,
    since: str = None,
    until: str = None,
    limit: int = 20,
):
    user: User = request.auth
    app = AppService.get_app_by_slug(user, app_slug)

    from apps.projects.services import AnalyticsService
    return AnalyticsService.get_endpoint_payloads(
        app_id=str(app.id),
        method=method,
        path=path,
        environment=environment,
        since=since,
        until=until,
        limit=limit,
    )
