import logging
from datetime import datetime, timedelta, timezone as tz

from django.db import transaction
from django.utils import timezone
from django.utils.text import slugify

from core.exceptions.base import NotFoundError, RateLimitError, ValidationError, ConflictError

from .models import App, Endpoint, Environment

logger = logging.getLogger(__name__)

MAX_APPS_PER_USER = 20

RESERVED_SLUGS = {
    "new", "create", "edit", "delete", "settings", "account",
    "admin", "api", "auth", "login", "logout", "signup", "register",
    "dashboard", "home", "help", "support",
    "null", "undefined", "true", "false",
    "system", "internal", "public", "private",
}


def _resolve_time_range(since: str | None, until: str | None) -> tuple[datetime, datetime]:
    now = datetime.now(tz.utc)
    since_dt = datetime.fromisoformat(since.replace("Z", "+00:00")) if since else now - timedelta(hours=24)
    until_dt = datetime.fromisoformat(until.replace("Z", "+00:00")) if until else now
    return since_dt, until_dt


def _unique_slug(user, name: str, exclude_id=None) -> str:
    base = slugify(name)[:100]
    if not base:
        base = "app"

    candidate = base
    counter = 1

    while True:
        if candidate in RESERVED_SLUGS:
            candidate = f"{base}-{counter}"
            counter += 1
            continue

        qs = App.objects.filter(owner=user, slug=candidate, is_active=True)
        if exclude_id:
            qs = qs.exclude(id=exclude_id)
        if not qs.exists():
            return candidate

        candidate = f"{base}-{counter}"
        counter += 1


class AppService:
    @staticmethod
    @transaction.atomic
    def create_app(user, name: str, description: str = "") -> App:
        name = name.strip()
        if not name:
            raise ValidationError("App name is required")

        if App.objects.for_user(user).count() >= MAX_APPS_PER_USER:
            raise RateLimitError(f"Maximum of {MAX_APPS_PER_USER} apps allowed")

        slug = _unique_slug(user, name)
        app = App.objects.create(
            owner=user,
            name=name,
            slug=slug,
            description=description.strip(),
        )
        EnvironmentService.create_default_environments(app)
        return app

    @staticmethod
    def list_apps(user) -> list[App]:
        return list(App.objects.for_user(user).order_by("-created_at"))

    @staticmethod
    def get_app_by_slug(user, slug: str) -> App:
        try:
            return App.objects.get(owner=user, slug=slug, is_active=True)
        except App.DoesNotExist:
            raise NotFoundError("App not found")

    @staticmethod
    @transaction.atomic
    def update_app(user, slug: str, name: str | None = None, description: str | None = None) -> App:
        app = AppService.get_app_by_slug(user, slug)

        if name is not None:
            name = name.strip()
            if not name:
                raise ValidationError("App name is required")
            app.name = name
            app.slug = _unique_slug(user, name, exclude_id=app.id)

        if description is not None:
            app.description = description.strip()

        app.save()
        return app

    @staticmethod
    @transaction.atomic
    def delete_app(user, slug: str) -> None:
        app = AppService.get_app_by_slug(user, slug)

        # Revoke all API keys for this app
        from apps.auth.services import ApiKeyService
        ApiKeyService.revoke_all_for_app(app)

        app.is_active = False
        app.save(update_fields=["is_active", "updated_at"])


class EndpointService:
    @staticmethod
    @transaction.atomic
    def create_endpoint(app, path: str, method: str = "GET", description: str = "") -> Endpoint:
        path = path.strip()
        if not path:
            raise ValidationError("Endpoint path is required")

        method = method.upper()
        if method not in Endpoint.Method.values:
            raise ValidationError(f"Invalid method: {method}")

        if Endpoint.objects.filter(app=app, path=path, method=method, is_active=True).exists():
            raise ConflictError(f"{method} {path} already exists")

        return Endpoint.objects.create(
            app=app,
            path=path,
            method=method,
            description=description.strip(),
        )

    @staticmethod
    def list_endpoints(app) -> list[Endpoint]:
        return list(Endpoint.objects.for_app(app))

    @staticmethod
    def get_endpoint(app, endpoint_id: str) -> Endpoint:
        try:
            return Endpoint.objects.get(id=endpoint_id, app=app, is_active=True)
        except Endpoint.DoesNotExist:
            raise NotFoundError("Endpoint not found")

    @staticmethod
    @transaction.atomic
    def update_endpoint(
        app, endpoint_id: str, path: str | None = None,
        method: str | None = None, description: str | None = None,
    ) -> Endpoint:
        endpoint = EndpointService.get_endpoint(app, endpoint_id)

        if path is not None:
            path = path.strip()
            if not path:
                raise ValidationError("Endpoint path is required")
            endpoint.path = path

        if method is not None:
            method = method.upper()
            if method not in Endpoint.Method.values:
                raise ValidationError(f"Invalid method: {method}")
            endpoint.method = method

        if description is not None:
            endpoint.description = description.strip()

        endpoint.save()
        return endpoint

    @staticmethod
    @transaction.atomic
    def delete_endpoint(app, endpoint_id: str) -> None:
        endpoint = EndpointService.get_endpoint(app, endpoint_id)
        endpoint.is_active = False
        endpoint.save(update_fields=["is_active", "updated_at"])


MAX_ENVIRONMENTS_PER_APP = 10

DEFAULT_ENVIRONMENTS = [
    {"name": "Production", "slug": "production", "color": "#ef4444", "order": 0},
    {"name": "Staging", "slug": "staging", "color": "#f59e0b", "order": 1},
    {"name": "Development", "slug": "development", "color": "#22c55e", "order": 2},
]


class EnvironmentService:
    @staticmethod
    def create_default_environments(app) -> list[Environment]:
        envs = []
        for env_data in DEFAULT_ENVIRONMENTS:
            envs.append(Environment.objects.create(app=app, **env_data))
        return envs

    @staticmethod
    @transaction.atomic
    def create_environment(app, name: str, color: str = "#6b7280") -> Environment:
        name = name.strip()
        if not name:
            raise ValidationError("Environment name is required")

        if Environment.objects.for_app(app).count() >= MAX_ENVIRONMENTS_PER_APP:
            raise RateLimitError(f"Maximum of {MAX_ENVIRONMENTS_PER_APP} environments per app")

        slug = slugify(name)
        if not slug:
            slug = "env"

        if Environment.objects.filter(app=app, slug=slug).exists():
            raise ConflictError(f"Environment '{name}' already exists")

        order = Environment.objects.filter(app=app).count()
        return Environment.objects.create(
            app=app, name=name, slug=slug, color=color, order=order,
        )

    @staticmethod
    def list_environments(app) -> list[Environment]:
        return list(Environment.objects.for_app(app))

    @staticmethod
    def get_environment(app, env_slug: str) -> Environment:
        try:
            return Environment.objects.get(app=app, slug=env_slug, is_active=True)
        except Environment.DoesNotExist:
            raise NotFoundError("Environment not found")

    @staticmethod
    @transaction.atomic
    def update_environment(
        app, env_slug: str, name: str | None = None, color: str | None = None,
    ) -> Environment:
        env = EnvironmentService.get_environment(app, env_slug)

        if name is not None:
            name = name.strip()
            if not name:
                raise ValidationError("Environment name is required")
            new_slug = slugify(name)
            if new_slug != env.slug and Environment.objects.filter(app=app, slug=new_slug).exists():
                raise ConflictError(f"Environment '{name}' already exists")
            env.name = name
            env.slug = new_slug

        if color is not None:
            env.color = color

        env.save()
        return env

    @staticmethod
    @transaction.atomic
    def delete_environment(app, env_slug: str) -> None:
        env = EnvironmentService.get_environment(app, env_slug)
        env.is_active = False
        env.save(update_fields=["is_active", "updated_at"])


class IngestService:
    @staticmethod
    def ingest(app_id: str, records: list) -> int:
        if not records:
            return 0

        from core.database.clickhouse.client import get_clickhouse_client
        client = get_clickhouse_client()

        method_choices = set(Endpoint.Method.values)

        # Track latest seen timestamp per (method, path) for endpoint auto-discovery.
        endpoint_last_seen: dict[tuple[str, str], datetime] = {}
        normalized_records: list[dict] = []

        for r in records:
            method = r.method.upper()
            path = r.path

            normalized_records.append(
                {
                    "timestamp": r.timestamp,
                    "environment": r.environment,
                    "method": method,
                    "path": path,
                    "status_code": r.status_code,
                    "response_time_ms": r.response_time_ms,
                    "request_size": r.request_size,
                    "response_size": r.response_size,
                    "ip_address": r.ip_address,
                    "user_agent": r.user_agent,
                }
            )

            # Endpoint model supports these methods only; unsupported methods still ingest.
            if method not in method_choices:
                continue
            key = (method, path)
            prev = endpoint_last_seen.get(key)
            if prev is None or r.timestamp > prev:
                endpoint_last_seen[key] = r.timestamp

        endpoint_map: dict[tuple[str, str], Endpoint] = {}
        if endpoint_last_seen:
            methods = {m for m, _ in endpoint_last_seen}
            paths = {p for _, p in endpoint_last_seen}

            existing = list(
                Endpoint.objects.filter(
                    app_id=app_id,
                    method__in=methods,
                    path__in=paths,
                )
            )
            for ep in existing:
                endpoint_map[(ep.method, ep.path)] = ep

            missing = [
                Endpoint(
                    app_id=app_id,
                    method=method,
                    path=path,
                    is_active=True,
                    last_seen_at=last_seen,
                )
                for (method, path), last_seen in endpoint_last_seen.items()
                if (method, path) not in endpoint_map
            ]
            if missing:
                Endpoint.objects.bulk_create(missing, ignore_conflicts=True)
                refreshed = list(
                    Endpoint.objects.filter(
                        app_id=app_id,
                        method__in=methods,
                        path__in=paths,
                    )
                )
                endpoint_map = {(ep.method, ep.path): ep for ep in refreshed}

            to_update: list[Endpoint] = []
            now = timezone.now()
            for key, seen_at in endpoint_last_seen.items():
                endpoint = endpoint_map.get(key)
                if not endpoint:
                    continue
                changed = False
                if not endpoint.is_active:
                    endpoint.is_active = True
                    changed = True
                if endpoint.last_seen_at is None or seen_at > endpoint.last_seen_at:
                    endpoint.last_seen_at = seen_at
                    changed = True
                if changed:
                    endpoint.updated_at = now
                    to_update.append(endpoint)

            if to_update:
                Endpoint.objects.bulk_update(to_update, ["is_active", "last_seen_at", "updated_at"])

        rows = []
        for r in normalized_records:
            endpoint_id = ""
            key = (r["method"], r["path"])
            endpoint = endpoint_map.get(key)
            if endpoint is not None:
                endpoint_id = str(endpoint.id)
            rows.append(
                {
                    "timestamp": r["timestamp"],
                    "app_id": app_id,
                    "endpoint_id": endpoint_id,
                    "environment": r["environment"],
                    "method": r["method"],
                    "path": r["path"],
                    "status_code": r["status_code"],
                    "response_time_ms": r["response_time_ms"],
                    "request_size": r["request_size"],
                    "response_size": r["response_size"],
                    "ip_address": r["ip_address"],
                    "user_agent": r["user_agent"],
                }
            )

        client.insert("api_requests", rows)
        return len(rows)


class EndpointStatsService:
    @staticmethod
    def get_endpoint_stats(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        status_classes: list[str] | None = None,
        status_codes: list[int] | None = None,
        methods: list[str] | None = None,
        paths: list[str] | None = None,
        endpoint_pairs: list[tuple[str, str]] | None = None,
        search: str | None = None,
        sort_by: str = "total_requests",
        sort_dir: str = "desc",
        page: int = 1,
        page_size: int = 25,
        status_class: str | None = None,
        status_code: int | None = None,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint stats: %s", exc)
            safe_page = max(1, int(page))
            safe_size = max(1, min(int(page_size), 200))
            return {"items": [], "total_count": 0, "page": safe_page, "page_size": safe_size}

        since_dt, until_dt = _resolve_time_range(since, until)

        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
        }

        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        normalized_classes: list[str] = []
        if status_classes:
            for item in status_classes:
                if item in {"2xx", "3xx", "4xx", "5xx"} and item not in normalized_classes:
                    normalized_classes.append(item)
        if status_class in {"2xx", "3xx", "4xx", "5xx"} and status_class not in normalized_classes:
            normalized_classes.append(status_class)

        normalized_codes: list[int] = []
        if status_codes:
            for item in status_codes:
                code = int(item)
                if 100 <= code <= 599 and code not in normalized_codes:
                    normalized_codes.append(code)
        if status_code is not None:
            code = int(status_code)
            if 100 <= code <= 599 and code not in normalized_codes:
                normalized_codes.append(code)

        status_predicates: list[str] = []
        for idx, cls in enumerate(normalized_classes):
            min_key = f"status_class_{idx}_min"
            max_key = f"status_class_{idx}_max"
            base = int(cls[0]) * 100
            params[min_key] = base
            params[max_key] = base + 100
            status_predicates.append(f"(status_code >= %({min_key})s AND status_code < %({max_key})s)")

        if normalized_codes:
            code_keys: list[str] = []
            for idx, code in enumerate(normalized_codes):
                key = f"status_code_{idx}"
                params[key] = code
                code_keys.append(f"%({key})s")
            status_predicates.append(f"(status_code IN ({', '.join(code_keys)}))")

        status_filter = ""
        if status_predicates:
            status_filter = f"AND ({' OR '.join(status_predicates)})"

        methods_filter = ""
        if methods:
            normalized_methods = []
            for method in methods:
                m = method.upper().strip()
                if m and m not in normalized_methods:
                    normalized_methods.append(m)
            if normalized_methods:
                method_keys: list[str] = []
                for idx, method in enumerate(normalized_methods):
                    key = f"method_{idx}"
                    params[key] = method
                    method_keys.append(f"%({key})s")
                methods_filter = f"AND method IN ({', '.join(method_keys)})"

        paths_filter = ""
        if paths:
            normalized_paths = []
            for p in paths:
                path = p.strip()
                if path and path not in normalized_paths:
                    normalized_paths.append(path)
            if normalized_paths:
                path_keys: list[str] = []
                for idx, p in enumerate(normalized_paths):
                    key = f"path_{idx}"
                    params[key] = p
                    path_keys.append(f"%({key})s")
                paths_filter = f"AND path IN ({', '.join(path_keys)})"

        endpoint_pairs_filter = ""
        if endpoint_pairs:
            normalized_pairs: list[tuple[str, str]] = []
            for method, path in endpoint_pairs:
                clean_method = (method or "").strip().upper()
                clean_path = (path or "").strip()
                if not clean_method or not clean_path:
                    continue
                pair = (clean_method, clean_path)
                if pair not in normalized_pairs:
                    normalized_pairs.append(pair)

            if normalized_pairs:
                pair_predicates: list[str] = []
                for idx, (method, path) in enumerate(normalized_pairs):
                    method_key = f"pair_method_{idx}"
                    path_key = f"pair_path_{idx}"
                    params[method_key] = method
                    params[path_key] = path
                    pair_predicates.append(f"(method = %({method_key})s AND path = %({path_key})s)")
                endpoint_pairs_filter = f"AND ({' OR '.join(pair_predicates)})"

        search_filter = ""
        normalized_search = (search or "").strip().lower()
        if normalized_search:
            params["search"] = f"%{normalized_search}%"
            search_filter = "AND (lower(path) LIKE %(search)s OR lower(method) LIKE %(search)s)"

        sort_map = {
            "endpoint": "method, path",
            "total_requests": "total_requests",
            "error_rate": "error_rate",
            "avg_response_time_ms": "avg_response_time_ms",
            "p95_response_time_ms": "p95_response_time_ms",
            "data_transfer": "(total_request_bytes + total_response_bytes)",
            "last_seen_at": "last_seen_at",
        }
        sort_expr = sort_map.get(sort_by, "total_requests")
        sort_direction = "ASC" if str(sort_dir).lower() == "asc" else "DESC"
        safe_page = max(1, int(page))
        safe_size = max(1, min(int(page_size), 200))
        offset = (safe_page - 1) * safe_size
        params["limit"] = safe_size
        params["offset"] = offset

        query = f"""
            SELECT
                method,
                path,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes,
                max(timestamp) AS last_seen_at
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
              {status_filter}
              {methods_filter}
              {paths_filter}
              {endpoint_pairs_filter}
              {search_filter}
            GROUP BY method, path
            ORDER BY {sort_expr} {sort_direction}
            LIMIT %(limit)s
            OFFSET %(offset)s
        """

        total_query = f"""
            SELECT count() AS total_count
            FROM (
                SELECT method, path
                FROM api_requests
                WHERE app_id = %(app_id)s
                  AND timestamp >= %(since)s
                  AND timestamp <= %(until)s
                  {env_filter}
                  {status_filter}
                  {methods_filter}
                  {paths_filter}
                  {endpoint_pairs_filter}
                  {search_filter}
                GROUP BY method, path
            )
        """

        try:
            items = client.execute(query, params)
            total_rows = client.execute(total_query, params)
            total_count = int(total_rows[0]["total_count"]) if total_rows else 0
            return {
                "items": items,
                "total_count": total_count,
                "page": safe_page,
                "page_size": safe_size,
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint stats; returning empty list: %s", exc)
            return {"items": [], "total_count": 0, "page": safe_page, "page_size": safe_size}

    @staticmethod
    def get_endpoint_options(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        status_classes: list[str] | None = None,
        status_codes: list[int] | None = None,
        methods: list[str] | None = None,
        search: str | None = None,
        limit: int = 500,
    ) -> list[dict]:
        # Reuse get_endpoint_stats filtering and request first page with large size,
        # but return only endpoint keys for dropdown options.
        data = EndpointStatsService.get_endpoint_stats(
            app_id=app_id,
            environment=environment,
            since=since,
            until=until,
            status_classes=status_classes,
            status_codes=status_codes,
            methods=methods,
            search=search,
            sort_by="total_requests",
            sort_dir="desc",
            page=1,
            page_size=max(1, min(limit, 1000)),
        )
        return [
            {
                "method": row["method"],
                "path": row["path"],
                "total_requests": row["total_requests"],
            }
            for row in data.get("items", [])
        ]


class ConsumerStatsService:
    @staticmethod
    def get_consumer_stats(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty consumer stats: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)

        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 100)),
        }

        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                if(user_agent = '', 'unknown', user_agent) AS consumer,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                max(timestamp) AS last_seen_at
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY consumer
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for consumer stats; returning empty list: %s", exc)
            return []


class AnalyticsService:
    @staticmethod
    def get_summary(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty analytics summary: %s", exc)
            return {
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "unique_endpoints": 0,
                "unique_consumers": 0,
            }

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {"app_id": app_id, "since": since_dt, "until": until_dt}
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes,
                uniqExact((method, path)) AS unique_endpoints,
                uniqExact(if(user_agent = '', 'unknown', user_agent)) AS unique_consumers
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
        """
        try:
            rows = client.execute(query, params)
            return rows[0] if rows else {
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "unique_endpoints": 0,
                "unique_consumers": 0,
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for analytics summary; returning empty summary: %s", exc)
            return {
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "unique_endpoints": 0,
                "unique_consumers": 0,
            }

    @staticmethod
    def get_timeseries(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty analytics timeseries: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {"app_id": app_id, "since": since_dt, "until": until_dt}
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                toStartOfHour(timestamp) AS bucket,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY bucket
            ORDER BY bucket ASC
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for analytics timeseries; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_related_apis(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty related api stats: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 100)),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                if(
                    length(splitByChar('/', trim(BOTH '/' FROM path))) = 0,
                    '/',
                    concat('/', splitByChar('/', trim(BOTH '/' FROM path))[1])
                ) AS family,
                uniqExact((method, path)) AS endpoint_count,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY family
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for related api stats; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_endpoint_detail(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint detail: %s", exc)
            return {
                "method": method.upper(),
                "path": path,
                "total_requests": 0,
                "error_count": 0,
                "error_rate": 0.0,
                "avg_response_time_ms": 0.0,
                "p95_response_time_ms": 0.0,
                "total_request_bytes": 0,
                "total_response_bytes": 0,
                "last_seen_at": None,
            }

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                method,
                path,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms,
                quantile(0.95)(response_time_ms) AS p95_response_time_ms,
                sum(request_size) AS total_request_bytes,
                sum(response_size) AS total_response_bytes,
                max(timestamp) AS last_seen_at
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY method, path
            LIMIT 1
        """
        try:
            rows = client.execute(query, params)
            if rows:
                return rows[0]
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint detail; returning empty detail: %s", exc)

        return {
            "method": method.upper(),
            "path": path,
            "total_requests": 0,
            "error_count": 0,
            "error_rate": 0.0,
            "avg_response_time_ms": 0.0,
            "p95_response_time_ms": 0.0,
            "total_request_bytes": 0,
            "total_response_bytes": 0,
            "last_seen_at": None,
        }

    @staticmethod
    def get_endpoint_timeseries(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint timeseries: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                toStartOfHour(timestamp) AS bucket,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                avg(response_time_ms) AS avg_response_time_ms
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY bucket
            ORDER BY bucket ASC
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint timeseries; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_endpoint_consumers(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 10,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint consumers: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 50)),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                if(user_agent = '', 'unknown', user_agent) AS consumer,
                count() AS total_requests,
                countIf(status_code >= 400) AS error_count,
                if(count() > 0, countIf(status_code >= 400) / count() * 100, 0) AS error_rate,
                avg(response_time_ms) AS avg_response_time_ms
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY consumer
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint consumers; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_endpoint_status_codes(
        app_id: str,
        method: str,
        path: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty endpoint status-code stats: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 50)),
        }
        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                status_code,
                count() AS total_requests
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            GROUP BY status_code
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint status-code stats; returning empty list: %s", exc)
            return []
