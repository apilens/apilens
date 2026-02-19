import logging
import os
import threading
import json
from typing import Any
from datetime import datetime, timedelta, timezone as tz
from io import BytesIO

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.text import slugify
from PIL import Image

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
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _resolve_time_range(since: str | None, until: str | None) -> tuple[datetime, datetime]:
    now = datetime.now(tz.utc)
    since_dt = datetime.fromisoformat(since.replace("Z", "+00:00")) if since else now - timedelta(hours=24)
    until_dt = datetime.fromisoformat(until.replace("Z", "+00:00")) if until else now
    return since_dt, until_dt


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=tz.utc)
    return value.astimezone(tz.utc)


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

        # Slug is protected by a DB unique constraint on (owner, slug),
        # so uniqueness must be checked across all rows, not only active ones.
        qs = App.objects.filter(owner=user, slug=candidate)
        if exclude_id:
            qs = qs.exclude(id=exclude_id)
        if not qs.exists():
            return candidate

        candidate = f"{base}-{counter}"
        counter += 1


class AppService:
    @staticmethod
    def create_app(
        user,
        name: str,
        description: str = "",
        framework: str = "fastapi",
    ) -> App:
        name = name.strip()
        if not name:
            raise ValidationError("App name is required")
        framework = (framework or "fastapi").strip().lower()
        if framework not in App.Framework.values:
            raise ValidationError("Invalid framework")

        if App.objects.for_user(user).count() >= MAX_APPS_PER_USER:
            raise RateLimitError(f"Maximum of {MAX_APPS_PER_USER} apps allowed")

        # Retry for rare concurrent create collisions.
        for attempt in range(5):
            slug = _unique_slug(user, name)
            try:
                with transaction.atomic():
                    app = App.objects.create(
                        owner=user,
                        name=name,
                        slug=slug,
                        description=description.strip(),
                        framework=framework,
                    )
                    return app
            except IntegrityError as exc:
                if "unique_owner_slug" in str(exc):
                    if attempt == 4:
                        raise ConflictError("App name already exists. Try a different name.")
                    continue
                raise

        raise ConflictError("Unable to create app with that name. Try a different name.")

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
    def update_app(
        user,
        slug: str,
        name: str | None = None,
        description: str | None = None,
        framework: str | None = None,
    ) -> App:
        app = AppService.get_app_by_slug(user, slug)

        if name is not None:
            name = name.strip()
            if not name:
                raise ValidationError("App name is required")
            app.name = name
            app.slug = _unique_slug(user, name, exclude_id=app.id)

        if description is not None:
            app.description = description.strip()

        if framework is not None:
            normalized = framework.strip().lower()
            if normalized not in App.Framework.values:
                raise ValidationError("Invalid framework")
            app.framework = normalized

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

    @staticmethod
    @transaction.atomic
    def update_icon(app: App, file) -> App:
        if file.content_type not in ALLOWED_IMAGE_TYPES:
            raise ValidationError("Only JPEG, PNG, and WebP images are allowed")

        max_size = getattr(settings, "APP_ICON_MAX_SIZE", 2 * 1024 * 1024)
        if file.size > max_size:
            raise ValidationError(f"Image must be smaller than {max_size // (1024 * 1024)}MB")

        try:
            img = Image.open(file)
            img.verify()
            file.seek(0)
            img = Image.open(file)
        except Exception:
            raise ValidationError("Invalid image file")

        max_dim = getattr(settings, "APP_ICON_MAX_DIMENSION", 512)
        if img.width > max_dim or img.height > max_dim:
            img.thumbnail((max_dim, max_dim), Image.LANCZOS)

        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")

        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=90)
        buffer.seek(0)

        if app.icon_image:
            try:
                old_path = app.icon_image.path
                if os.path.exists(old_path):
                    os.remove(old_path)
            except Exception:
                pass

        app.icon_image.save(
            f"{app.id}.jpg",
            ContentFile(buffer.read()),
            save=False,
        )
        app.save(update_fields=["icon_image", "updated_at"])
        return app

    @staticmethod
    @transaction.atomic
    def remove_icon(app: App) -> App:
        if app.icon_image:
            try:
                old_path = app.icon_image.path
                if os.path.exists(old_path):
                    os.remove(old_path)
            except Exception:
                pass
            app.icon_image = ""
            app.save(update_fields=["icon_image", "updated_at"])
        return app


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
    MAX_PAYLOAD_CHARS = 16_384
    MAX_LOG_MESSAGE_CHARS = 8_192
    MAX_LOG_PAYLOAD_CHARS = 16_384
    MAX_LOG_ATTRIBUTE_KEY_CHARS = 64
    MAX_LOG_ATTRIBUTE_VALUE_CHARS = 512
    MAX_LOG_ATTRIBUTES = 64
    _payload_columns_ready = False
    _payload_columns_lock = threading.Lock()
    _consumer_columns_ready = False
    _consumer_columns_lock = threading.Lock()
    _api_logs_table_ready = False
    _api_logs_table_lock = threading.Lock()

    @staticmethod
    def ensure_payload_columns(client) -> None:
        if IngestService._payload_columns_ready:
            return
        with IngestService._payload_columns_lock:
            if IngestService._payload_columns_ready:
                return
            try:
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS request_payload String CODEC(ZSTD(3))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS response_payload String CODEC(ZSTD(3))"
                )
            except Exception as exc:
                logger.warning("Unable to ensure payload columns on api_requests: %s", exc)
                return
            IngestService._payload_columns_ready = True

    @staticmethod
    def ensure_consumer_columns(client) -> None:
        if IngestService._consumer_columns_ready:
            return
        with IngestService._consumer_columns_lock:
            if IngestService._consumer_columns_ready:
                return
            try:
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_id String CODEC(ZSTD(3))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_name String CODEC(ZSTD(3))"
                )
                client.execute(
                    "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_group String CODEC(ZSTD(3))"
                )
            except Exception as exc:
                logger.warning("Unable to ensure consumer columns on api_requests: %s", exc)
                return
            IngestService._consumer_columns_ready = True

    @staticmethod
    def _safe_payload(value: str) -> str:
        if not value:
            return ""
        text = str(value)
        if len(text) <= IngestService.MAX_PAYLOAD_CHARS:
            return text
        return text[: IngestService.MAX_PAYLOAD_CHARS]

    @staticmethod
    def ensure_api_logs_table(client) -> None:
        if IngestService._api_logs_table_ready:
            return
        with IngestService._api_logs_table_lock:
            if IngestService._api_logs_table_ready:
                return
            try:
                client.execute(
                    """
                    CREATE TABLE IF NOT EXISTS api_logs (
                        timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
                        app_id String CODEC(ZSTD(1)),
                        environment LowCardinality(String) CODEC(ZSTD(1)),
                        level LowCardinality(String) CODEC(ZSTD(1)),
                        message String CODEC(ZSTD(3)),
                        logger_name LowCardinality(String) CODEC(ZSTD(1)),
                        payload String CODEC(ZSTD(3)),
                        attributes_json String CODEC(ZSTD(3))
                    ) ENGINE = MergeTree()
                    PARTITION BY toYYYYMM(timestamp)
                    ORDER BY (app_id, environment, level, timestamp)
                    TTL toDateTime(timestamp) + INTERVAL 30 DAY
                    SETTINGS index_granularity = 8192
                    """
                )
                client.execute(
                    "ALTER TABLE api_logs ADD INDEX IF NOT EXISTS idx_api_logs_app_id app_id TYPE bloom_filter(0.01) GRANULARITY 1"
                )
                client.execute(
                    "ALTER TABLE api_logs ADD INDEX IF NOT EXISTS idx_api_logs_environment environment TYPE bloom_filter(0.01) GRANULARITY 1"
                )
                client.execute(
                    "ALTER TABLE api_logs ADD INDEX IF NOT EXISTS idx_api_logs_level level TYPE set(10) GRANULARITY 1"
                )
                client.execute(
                    "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS attributes_json String CODEC(ZSTD(3))"
                )
            except Exception as exc:
                logger.warning("Unable to ensure api_logs table: %s", exc)
                return
            IngestService._api_logs_table_ready = True

    @staticmethod
    def _safe_log_text(value: str, *, limit: int) -> str:
        if not value:
            return ""
        text = str(value)
        if len(text) <= limit:
            return text
        return text[:limit]

    @staticmethod
    def _normalize_log_level(value: str) -> str:
        level = (value or "INFO").strip().upper()
        if level in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            return level
        if level == "WARN":
            return "WARNING"
        return "INFO"

    @staticmethod
    def _sanitize_log_attributes(attributes: Any) -> dict[str, str]:
        if not isinstance(attributes, dict):
            return {}
        output: dict[str, str] = {}
        for key, raw_value in attributes.items():
            if len(output) >= IngestService.MAX_LOG_ATTRIBUTES:
                break
            clean_key = str(key or "").strip()
            if not clean_key:
                continue
            clean_key = clean_key[: IngestService.MAX_LOG_ATTRIBUTE_KEY_CHARS]
            # Keep attributes flat and scalar only (no nested objects/lists).
            if isinstance(raw_value, (dict, list, tuple, set)):
                continue
            output[clean_key] = IngestService._safe_log_text(
                str(raw_value or ""),
                limit=IngestService.MAX_LOG_ATTRIBUTE_VALUE_CHARS,
            )
        return output

    @staticmethod
    def ingest(app_id: str, records: list) -> int:
        if not records:
            return 0

        from core.database.clickhouse.client import get_clickhouse_client
        client = get_clickhouse_client()
        IngestService.ensure_payload_columns(client)
        IngestService.ensure_consumer_columns(client)

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
                    "consumer_id": (getattr(r, "consumer_id", "") or "")[:256],
                    "consumer_name": (getattr(r, "consumer_name", "") or "")[:256],
                    "consumer_group": (getattr(r, "consumer_group", "") or "")[:256],
                    "request_payload": IngestService._safe_payload(r.request_payload),
                    "response_payload": IngestService._safe_payload(r.response_payload),
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
                    "consumer_id": r["consumer_id"],
                    "consumer_name": r["consumer_name"],
                    "consumer_group": r["consumer_group"],
                    "request_payload": r["request_payload"],
                    "response_payload": r["response_payload"],
                }
            )

        client.insert("api_requests", rows)
        return len(rows)

    @staticmethod
    def ingest_logs(app_id: str, records: list) -> int:
        if not records:
            return 0

        from core.database.clickhouse.client import get_clickhouse_client

        client = get_clickhouse_client()
        IngestService.ensure_api_logs_table(client)

        rows: list[dict[str, Any]] = []
        for record in records:
            attributes = IngestService._sanitize_log_attributes(getattr(record, "attributes", {}))

            rows.append(
                {
                    "timestamp": record.timestamp,
                    "app_id": app_id,
                    "environment": (record.environment or "production").strip().lower(),
                    "level": IngestService._normalize_log_level(record.level),
                    "message": IngestService._safe_log_text(
                        record.message,
                        limit=IngestService.MAX_LOG_MESSAGE_CHARS,
                    ),
                    "logger_name": IngestService._safe_log_text(
                        getattr(record, "logger_name", ""),
                        limit=256,
                    ),
                    "payload": IngestService._safe_log_text(
                        getattr(record, "payload", ""),
                        limit=IngestService.MAX_LOG_PAYLOAD_CHARS,
                    ),
                    "attributes_json": json.dumps(attributes, separators=(",", ":")),
                }
            )

        if not rows:
            return 0

        client.insert("api_logs", rows)
        return len(rows)


class EndpointStatsService:
    @staticmethod
    def get_endpoint_meta(app_id: str, endpoint_id: str) -> dict:
        try:
            endpoint = Endpoint.objects.get(id=endpoint_id, app_id=app_id, is_active=True)
        except Endpoint.DoesNotExist as exc:
            raise NotFoundError("Endpoint not found") from exc
        return {
            "id": str(endpoint.id),
            "method": endpoint.method,
            "path": endpoint.path,
        }

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

        safe_page = max(1, int(page))
        safe_size = max(1, min(int(page_size), 200))

        client = None
        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; continuing with endpoint-only stats: %s", exc)

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
        normalized_methods: list[str] = []
        if methods:
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
        normalized_paths: list[str] = []
        if paths:
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
        normalized_pairs: list[tuple[str, str]] = []
        if endpoint_pairs:
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
        """

        try:
            stats_rows = client.execute(query, params) if client is not None else []
            for row in stats_rows:
                row["last_seen_at"] = _as_utc(row.get("last_seen_at"))
            stats_map: dict[tuple[str, str], dict] = {
                (row["method"], row["path"]): row for row in stats_rows
            }

            endpoint_qs = Endpoint.objects.filter(app_id=app_id, is_active=True)
            if normalized_methods:
                endpoint_qs = endpoint_qs.filter(method__in=normalized_methods)
            if normalized_paths:
                endpoint_qs = endpoint_qs.filter(path__in=normalized_paths)
            if normalized_pairs:
                pair_query = Q()
                for pair_method, pair_path in normalized_pairs:
                    pair_query |= Q(method=pair_method, path=pair_path)
                endpoint_qs = endpoint_qs.filter(pair_query)
            if normalized_search:
                endpoint_qs = endpoint_qs.filter(
                    Q(path__icontains=normalized_search) | Q(method__icontains=normalized_search)
                )

            endpoints = list(endpoint_qs)
            endpoint_model_map: dict[tuple[str, str], Endpoint] = {
                (endpoint.method, endpoint.path): endpoint for endpoint in endpoints
            }

            items: list[dict] = []
            endpoint_keys: set[tuple[str, str]] = set()
            for endpoint in endpoints:
                key = (endpoint.method, endpoint.path)
                endpoint_keys.add(key)
                row = stats_map.get(key)
                if row:
                    row["endpoint_id"] = str(endpoint.id)
                    items.append(row)
                    continue
                items.append(
                    {
                        "endpoint_id": str(endpoint.id),
                        "method": endpoint.method,
                        "path": endpoint.path,
                        "total_requests": 0,
                        "error_count": 0,
                        "error_rate": 0.0,
                        "avg_response_time_ms": 0.0,
                        "p95_response_time_ms": 0.0,
                        "total_request_bytes": 0,
                        "total_response_bytes": 0,
                        "last_seen_at": _as_utc(endpoint.last_seen_at),
                    }
                )

            for key, row in stats_map.items():
                if key not in endpoint_keys:
                    row["endpoint_id"] = None
                    items.append(row)

            reverse = str(sort_dir).lower() != "asc"
            if sort_by == "endpoint":
                items.sort(key=lambda row: (str(row.get("method", "")), str(row.get("path", ""))), reverse=reverse)
            elif sort_by == "error_rate":
                items.sort(key=lambda row: float(row.get("error_rate") or 0.0), reverse=reverse)
            elif sort_by == "avg_response_time_ms":
                items.sort(key=lambda row: float(row.get("avg_response_time_ms") or 0.0), reverse=reverse)
            elif sort_by == "p95_response_time_ms":
                items.sort(key=lambda row: float(row.get("p95_response_time_ms") or 0.0), reverse=reverse)
            elif sort_by == "data_transfer":
                items.sort(
                    key=lambda row: int(row.get("total_request_bytes") or 0) + int(row.get("total_response_bytes") or 0),
                    reverse=reverse,
                )
            elif sort_by == "last_seen_at":
                items.sort(
                    key=lambda row: _as_utc(row.get("last_seen_at")) or datetime.min.replace(tzinfo=tz.utc),
                    reverse=reverse,
                )
            else:
                items.sort(key=lambda row: int(row.get("total_requests") or 0), reverse=reverse)

            total_count = len(items)
            offset = (safe_page - 1) * safe_size
            page_items = items[offset: offset + safe_size]
            return {
                "items": page_items,
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

    @staticmethod
    def get_environment_options(
        app_id: str,
        since: str | None = None,
        until: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty environment options: %s", exc)
            return []

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 100)),
        }
        query = """
            SELECT
                environment,
                count() AS total_requests
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              AND length(environment) > 0
            GROUP BY environment
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for environment options; returning empty list: %s", exc)
            return []


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
        IngestService.ensure_consumer_columns(client)

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
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        if(user_agent != '', user_agent, if(ip_address != '', ip_address, 'unknown'))
                    )
                ) AS consumer,
                if(consumer_id != '', consumer_id, '') AS consumer_identifier,
                if(consumer_name != '', consumer_name, '') AS consumer_name,
                if(consumer_group != '', consumer_group, '') AS consumer_group,
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
            GROUP BY consumer, consumer_identifier, consumer_name, consumer_group
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for consumer stats; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_consumer_request_stats(
        app_id: str,
        consumer: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        if not consumer or not consumer.strip():
            return []

    @staticmethod
    def get_consumer_activity(
        app_id: str,
        consumer: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        method: str | None = None,
        path: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        if not consumer or not consumer.strip():
            return []

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning(
                "ClickHouse client initialization failed; returning empty consumer activity: %s",
                exc,
            )
            return []
        IngestService.ensure_payload_columns(client)
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "consumer": consumer.strip(),
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 500)),
        }

        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        method_filter = ""
        if method:
            method_filter = "AND method = %(method)s"
            params["method"] = method.upper().strip()

        path_filter = ""
        if path:
            path_filter = "AND path = %(path)s"
            params["path"] = path.strip()

        query = f"""
            SELECT
                timestamp,
                method,
                path,
                status_code,
                response_time_ms,
                environment,
                consumer_id,
                consumer_name,
                consumer_group,
                request_payload,
                response_payload
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
              {method_filter}
              {path_filter}
              AND if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        if(user_agent != '', user_agent, if(ip_address != '', ip_address, 'unknown'))
                    )
                  ) = %(consumer)s
            ORDER BY timestamp DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning(
                "ClickHouse query failed for consumer activity; returning empty list: %s",
                exc,
            )
            return []

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning(
                "ClickHouse client initialization failed; returning empty consumer request stats: %s",
                exc,
            )
            return []
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)

        params = {
            "app_id": app_id,
            "consumer": consumer.strip(),
            "since": since_dt,
            "until": until_dt,
            "limit": max(1, min(limit, 500)),
        }

        env_filter = ""
        if environment:
            env_filter = "AND environment = %(environment)s"
            params["environment"] = environment

        query = f"""
            SELECT
                %(consumer)s AS consumer,
                method,
                path,
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
              AND if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        if(user_agent != '', user_agent, if(ip_address != '', ip_address, 'unknown'))
                    )
                  ) = %(consumer)s
            GROUP BY method, path
            ORDER BY total_requests DESC
            LIMIT %(limit)s
        """
        try:
            rows = client.execute(query, params)
            for row in rows:
                row["last_seen_at"] = _as_utc(row.get("last_seen_at"))
            return rows
        except Exception as exc:
            logger.warning(
                "ClickHouse query failed for consumer request stats; returning empty list: %s",
                exc,
            )
            return []


class LogsService:
    @staticmethod
    def _build_log_filters(
        params: dict[str, Any],
        environment: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
    ) -> str:
        filters: list[str] = []
        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment

        normalized_levels: list[str] = []
        if levels:
            for raw in levels:
                value = IngestService._normalize_log_level(raw)
                if value not in normalized_levels:
                    normalized_levels.append(value)
        if normalized_levels:
            level_placeholders: list[str] = []
            for idx, level in enumerate(normalized_levels):
                key = f"level_{idx}"
                params[key] = level
                level_placeholders.append(f"%({key})s")
            filters.append(f"AND level IN ({', '.join(level_placeholders)})")

        if logger_filters:
            logger_placeholders: list[str] = []
            for idx, logger_name in enumerate(logger_filters):
                key = f"logger_{idx}"
                params[key] = logger_name
                logger_placeholders.append(f"%({key})s")
            filters.append(f"AND logger_name IN ({', '.join(logger_placeholders)})")

        if attribute_filters:
            for idx, (attr_key, attr_value) in enumerate(attribute_filters):
                key_name = f"attr_key_{idx}"
                value_name = f"attr_value_{idx}"
                params[key_name] = attr_key
                params[value_name] = attr_value
                filters.append(
                    f"AND JSONExtractString(attributes_json, %({key_name})s) = %({value_name})s"
                )

        if search:
            filters.append(
                "AND (lower(message) LIKE %(search)s OR lower(logger_name) LIKE %(search)s OR lower(attributes_json) LIKE %(search)s)"
            )
            params["search"] = f"%{search.strip().lower()}%"

        return "\n              ".join(filters)

    @staticmethod
    def get_logs(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        safe_page = max(1, int(page))
        safe_size = max(1, min(int(page_size), 200))
        offset = (safe_page - 1) * safe_size

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs list: %s", exc)
            return {
                "items": [],
                "total_count": 0,
                "page": safe_page,
                "page_size": safe_size,
            }

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": safe_size,
            "offset": offset,
        }

        where_filters = LogsService._build_log_filters(
            params,
            environment=environment,
            levels=levels,
            search=search,
            attribute_filters=attribute_filters,
            logger_filters=logger_filters,
        )

        count_query = f"""
            SELECT count() AS total_count
            FROM api_logs
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
        """

        rows_query = f"""
            SELECT
                timestamp,
                environment,
                level,
                message,
                logger_name,
                payload,
                attributes_json
            FROM api_logs
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
            ORDER BY timestamp DESC
            LIMIT %(limit)s
            OFFSET %(offset)s
        """
        try:
            count_rows = client.execute(count_query, params)
            total_count = int(count_rows[0]["total_count"]) if count_rows else 0
            items = client.execute(rows_query, params)
            for item in items:
                item["timestamp"] = _as_utc(item.get("timestamp"))
                raw_attributes = item.get("attributes_json", "") or "{}"
                try:
                    parsed = json.loads(raw_attributes)
                    if not isinstance(parsed, dict):
                        parsed = {}
                except Exception:
                    parsed = {}
                item["attributes"] = {str(k): str(v) for k, v in parsed.items()}
                item.pop("attributes_json", None)
            return {
                "items": items,
                "total_count": total_count,
                "page": safe_page,
                "page_size": safe_size,
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for logs; returning empty list: %s", exc)
            return {
                "items": [],
                "total_count": 0,
                "page": safe_page,
                "page_size": safe_size,
            }

    @staticmethod
    def get_logs_summary(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs summary: %s", exc)
            return {
                "total_logs": 0,
                "error_logs": 0,
                "warning_logs": 0,
                "unique_loggers": 0,
            }

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
        }
        where_filters = LogsService._build_log_filters(
            params,
            environment=environment,
            levels=levels,
            search=search,
            attribute_filters=attribute_filters,
            logger_filters=logger_filters,
        )

        query = f"""
            SELECT
                count() AS total_logs,
                countIf(level IN ('ERROR', 'CRITICAL')) AS error_logs,
                countIf(level = 'WARNING') AS warning_logs,
                uniqExactIf(logger_name, logger_name != '') AS unique_loggers
            FROM api_logs
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
        """
        try:
            rows = client.execute(query, params)
            if rows:
                return rows[0]
        except Exception as exc:
            logger.warning("ClickHouse query failed for logs summary; returning empty summary: %s", exc)

        return {
            "total_logs": 0,
            "error_logs": 0,
            "warning_logs": 0,
            "unique_loggers": 0,
        }

    @staticmethod
    def get_logs_timeseries(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        levels: list[str] | None = None,
        search: str | None = None,
        attribute_filters: list[tuple[str, str]] | None = None,
        logger_filters: list[str] | None = None,
        bucket_minutes: int = 5,
    ) -> list[dict]:
        from core.database.clickhouse.client import get_clickhouse_client

        allowed_buckets = {5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440}
        safe_bucket = int(bucket_minutes) if int(bucket_minutes) in allowed_buckets else 5

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs timeseries: %s", exc)
            return []

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "bucket_minutes": safe_bucket,
        }

        where_filters = LogsService._build_log_filters(
            params,
            environment=environment,
            levels=levels,
            search=search,
            attribute_filters=attribute_filters,
            logger_filters=logger_filters,
        )

        query = f"""
            SELECT
                toStartOfInterval(timestamp, toIntervalMinute(%(bucket_minutes)s)) AS bucket,
                count() AS count
            FROM api_logs
            WHERE app_id = %(app_id)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {where_filters}
            GROUP BY bucket
            ORDER BY bucket ASC
        """

        try:
            rows = client.execute(query, params)
            for row in rows:
                row["bucket"] = _as_utc(row.get("bucket"))
            return rows
        except Exception as exc:
            logger.warning("ClickHouse query failed for logs timeseries; returning empty list: %s", exc)
            return []

    @staticmethod
    def get_logs_search_options(
        app_id: str,
        environment: str | None = None,
        since: str | None = None,
        until: str | None = None,
        key: str | None = None,
        prefix: str | None = None,
        limit: int = 12,
    ) -> dict:
        from core.database.clickhouse.client import get_clickhouse_client

        safe_limit = max(1, min(int(limit), 50))
        normalized_prefix = (prefix or "").strip().lower()
        normalized_key = (key or "").strip()
        high_cardinality_keys = {
            "trace_id",
            "span_id",
            "request_id",
            "session_id",
            "user_id",
            "device_id",
            "event_id",
            "uuid",
            "id",
        }

        try:
            client = get_clickhouse_client()
        except Exception as exc:
            logger.warning("ClickHouse client initialization failed; returning empty logs search options: %s", exc)
            return {"keys": [], "values": [], "loggers": []}

        IngestService.ensure_api_logs_table(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params: dict[str, Any] = {
            "app_id": app_id,
            "since": since_dt,
            "until": until_dt,
            "limit": safe_limit,
        }
        filters: list[str] = []
        if environment:
            filters.append("AND environment = %(environment)s")
            params["environment"] = environment
        if normalized_prefix:
            params["prefix_like"] = f"%{normalized_prefix}%"
        where_filters = "\n              ".join(filters)

        try:
            key_rows = client.execute(
                f"""
                SELECT key
                FROM (
                    SELECT arrayJoin(JSONExtractKeys(attributes_json)) AS key
                    FROM api_logs
                    WHERE app_id = %(app_id)s
                      AND timestamp >= %(since)s
                      AND timestamp <= %(until)s
                      {where_filters}
                )
                WHERE key != ''
                  {"AND lower(key) LIKE %(prefix_like)s" if normalized_prefix else ""}
                GROUP BY key
                ORDER BY count() DESC
                LIMIT %(limit)s
                """,
                params,
            )
            logger_rows = client.execute(
                f"""
                SELECT logger_name AS value
                FROM api_logs
                WHERE app_id = %(app_id)s
                  AND timestamp >= %(since)s
                  AND timestamp <= %(until)s
                  {where_filters}
                  AND logger_name != ''
                  {"AND lower(logger_name) LIKE %(prefix_like)s" if normalized_prefix else ""}
                GROUP BY value
                ORDER BY count() DESC
                LIMIT %(limit)s
                """,
                params,
            )

            value_rows: list[dict[str, Any]] = []
            if normalized_key.lower() == "logger":
                value_rows = logger_rows
            elif normalized_key:
                # Prevent expensive scans on likely high-cardinality keys.
                if normalized_key.lower() in high_cardinality_keys and len(normalized_prefix) < 4:
                    return {
                        "keys": [str(row.get("key", "")) for row in key_rows if row.get("key")],
                        "values": [],
                        "loggers": [str(row.get("value", "")) for row in logger_rows if row.get("value")],
                    }
                value_params = dict(params)
                value_params["attr_key"] = normalized_key
                value_rows = client.execute(
                    f"""
                    SELECT value
                    FROM (
                        SELECT JSONExtractString(attributes_json, %(attr_key)s) AS value
                        FROM api_logs
                        WHERE app_id = %(app_id)s
                          AND timestamp >= %(since)s
                          AND timestamp <= %(until)s
                          {where_filters}
                    )
                    WHERE value != ''
                      {"AND lower(value) LIKE %(prefix_like)s" if normalized_prefix else ""}
                    GROUP BY value
                    ORDER BY count() DESC
                    LIMIT %(limit)s
                    """,
                    value_params,
                )

            return {
                "keys": [str(row.get("key", "")) for row in key_rows if row.get("key")],
                "values": [str(row.get("value", "")) for row in value_rows if row.get("value")],
                "loggers": [str(row.get("value", "")) for row in logger_rows if row.get("value")],
            }
        except Exception as exc:
            logger.warning("ClickHouse query failed for logs search options; returning empty options: %s", exc)
            return {"keys": [], "values": [], "loggers": []}


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
        IngestService.ensure_consumer_columns(client)

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
                uniqExact(
                    if(
                        consumer_name != '',
                        consumer_name,
                        if(
                            consumer_id != '',
                            consumer_id,
                            if(user_agent != '', user_agent, if(ip_address != '', ip_address, 'unknown'))
                        )
                    )
                ) AS unique_consumers
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
        IngestService.ensure_consumer_columns(client)

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
                if(
                    consumer_name != '',
                    consumer_name,
                    if(
                        consumer_id != '',
                        consumer_id,
                        if(user_agent != '', user_agent, if(ip_address != '', ip_address, 'unknown'))
                    )
                ) AS consumer,
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

    @staticmethod
    def get_endpoint_payloads(
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
            logger.warning("ClickHouse client initialization failed; returning empty endpoint payloads: %s", exc)
            return []
        IngestService.ensure_payload_columns(client)
        IngestService.ensure_consumer_columns(client)

        since_dt, until_dt = _resolve_time_range(since, until)
        params = {
            "app_id": app_id,
            "method": method.upper(),
            "path": path,
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
                timestamp,
                method,
                path,
                status_code,
                response_time_ms,
                environment,
                ip_address,
                user_agent,
                consumer_id,
                consumer_name,
                consumer_group,
                request_payload,
                response_payload
            FROM api_requests
            WHERE app_id = %(app_id)s
              AND method = %(method)s
              AND path = %(path)s
              AND timestamp >= %(since)s
              AND timestamp <= %(until)s
              {env_filter}
            ORDER BY timestamp DESC
            LIMIT %(limit)s
        """
        try:
            return client.execute(query, params)
        except Exception as exc:
            logger.warning("ClickHouse query failed for endpoint payload samples; returning empty list: %s", exc)
            return []
