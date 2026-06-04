"""Ingest core — a faithful port of apps/api IngestService for the standalone
service. Resolves apps, auto-discovers endpoints in Postgres, and writes to the
same ClickHouse tables (api_requests / api_logs).

Kept deliberately in lock-step with:
  apps/api/apps/projects/services.py  (IngestService)
  apps/api/routers/ingest/router.py   (validate_project_slug / resolve_app_identifiers)
"""

from __future__ import annotations

import json
import threading
import uuid
from collections import defaultdict

from .config import MAX_BATCH_SIZE
from .db import clickhouse, pg_conn

ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}

MAX_PAYLOAD_CHARS = 16_384
MAX_LOG_MESSAGE_CHARS = 8_192
MAX_LOG_PAYLOAD_CHARS = 16_384
MAX_LOG_ATTRIBUTE_KEY_CHARS = 64
MAX_LOG_ATTRIBUTE_VALUE_CHARS = 512
MAX_LOG_ATTRIBUTES = 64

REQUEST_COLUMNS = [
    "timestamp", "app_id", "project_id", "endpoint_id", "environment", "method",
    "path", "status_code", "response_time_ms", "request_size", "response_size",
    "ip_address", "user_agent", "consumer_id", "consumer_name", "consumer_group",
    "request_payload", "response_payload",
]
LOG_COLUMNS = [
    "timestamp", "app_id", "project_id", "environment", "level", "message",
    "logger_name", "payload", "attributes_json",
]


class IngestError(Exception):
    """Maps to an HTTP status (mirrors the backend's domain exceptions)."""

    def __init__(self, status_code: int, error: str, detail):
        self.status_code = status_code
        self.error = error
        self.detail = detail
        super().__init__(detail if isinstance(detail, str) else error)


# --- sanitization (mirrors IngestService) ----------------------------------

def _safe_payload(value: str) -> str:
    if not value:
        return ""
    text = str(value)
    return text[:MAX_PAYLOAD_CHARS]


def _safe_log_text(value: str, *, limit: int) -> str:
    if not value:
        return ""
    return str(value)[:limit]


def _normalize_log_level(value: str) -> str:
    level = (value or "INFO").strip().upper()
    if level in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        return level
    if level == "WARN":
        return "WARNING"
    return "INFO"


def _sanitize_log_attributes(attributes) -> dict[str, str]:
    if not isinstance(attributes, dict):
        return {}
    output: dict[str, str] = {}
    for key, raw_value in attributes.items():
        if len(output) >= MAX_LOG_ATTRIBUTES:
            break
        clean_key = str(key or "").strip()
        if not clean_key:
            continue
        clean_key = clean_key[:MAX_LOG_ATTRIBUTE_KEY_CHARS]
        if isinstance(raw_value, (dict, list, tuple, set)):
            continue
        output[clean_key] = _safe_log_text(str(raw_value or ""), limit=MAX_LOG_ATTRIBUTE_VALUE_CHARS)
    return output


# --- ClickHouse schema safety (mirrors ensure_* runtime behavior) -----------
# The base tables are owned by apps/api's `clickhouse_migrate`; here we only
# ensure the same incremental columns the Django ingest path ensures at runtime.

_schema_lock = threading.Lock()
_schema_ready = False


def ensure_clickhouse_schema(client) -> None:
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        stmts = [
            "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS project_id String CODEC(ZSTD(1))",
            "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS request_payload String CODEC(ZSTD(3))",
            "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS response_payload String CODEC(ZSTD(3))",
            "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_id String CODEC(ZSTD(3))",
            "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_name String CODEC(ZSTD(3))",
            "ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS consumer_group String CODEC(ZSTD(3))",
            "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS project_id String CODEC(ZSTD(1))",
            "ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS attributes_json String CODEC(ZSTD(3))",
        ]
        for s in stmts:
            client.execute(s)
        _schema_ready = True


# --- validation + resolution (mirrors router.py) ----------------------------

def validate_project_slug(auth_slug: str, payload_slugs: set[str]) -> None:
    if not auth_slug:
        raise IngestError(401, "authentication_error", "API key must be scoped to a project")
    provided = {s.strip() for s in payload_slugs if s and s.strip()}
    if provided and provided != {auth_slug}:
        raise IngestError(422, "validation_error", f"project_slug must match the API key project '{auth_slug}'")


def resolve_app_identifiers(cur, project_id: str, identifiers: set[str]) -> dict[str, str]:
    if any(not (i or "").strip() for i in identifiers):
        raise IngestError(422, "validation_error", "app_id is required for every record")

    uuids, slugs = set(), set()
    for ident in identifiers:
        try:
            uuid.UUID(ident)
            uuids.add(ident)
        except (ValueError, AttributeError):
            slugs.add(ident)

    cur.execute(
        """
        SELECT id, slug FROM apps
        WHERE project_id = %s AND is_active = true
          AND (id = ANY(%s::uuid[]) OR slug = ANY(%s))
        """,
        (project_id, list(uuids), list(slugs)),
    )
    mapping: dict[str, str] = {}
    found_uuids, found_slugs = set(), set()
    for app_id, slug in cur.fetchall():
        u = str(app_id)
        mapping[u] = u
        mapping[slug] = u
        found_uuids.add(u)
        found_slugs.add(slug)

    invalid = (uuids - found_uuids) | (slugs - found_slugs)
    if invalid:
        raise IngestError(422, "validation_error", f"Invalid app identifiers: {sorted(invalid)}")
    return mapping


def discover_endpoints(cur, app_id: str, records) -> dict[tuple[str, str], str]:
    """Upsert (app, method, path) endpoints, bumping last_seen_at; return id map."""
    last_seen: dict[tuple[str, str], object] = {}
    for r in records:
        method = r.method.upper()
        if method not in ALLOWED_METHODS:
            continue
        key = (method, r.path)
        prev = last_seen.get(key)
        if prev is None or r.timestamp > prev:
            last_seen[key] = r.timestamp

    endpoint_map: dict[tuple[str, str], str] = {}
    for (method, path), seen_at in last_seen.items():
        cur.execute(
            """
            INSERT INTO endpoints
                (id, app_id, path, method, description, is_active, last_seen_at, created_at, updated_at)
            VALUES (%s, %s, %s, %s, '', true, %s, now(), now())
            ON CONFLICT (app_id, path, method) DO UPDATE
                SET last_seen_at = GREATEST(endpoints.last_seen_at, EXCLUDED.last_seen_at),
                    is_active = true,
                    updated_at = now()
            RETURNING id
            """,
            (str(uuid.uuid4()), app_id, path, method, seen_at),
        )
        endpoint_map[(method, path)] = str(cur.fetchone()[0])
    return endpoint_map


# --- public entrypoints ------------------------------------------------------

def handle_requests(project_id: str, project_slug: str, records) -> int:
    if len(records) > MAX_BATCH_SIZE:
        raise IngestError(422, "validation_error", f"Batch size exceeds maximum of {MAX_BATCH_SIZE}")
    if not records:
        return 0

    validate_project_slug(project_slug, {r.project_slug for r in records})

    with pg_conn() as conn:
        with conn.cursor() as cur:
            id_to_uuid = resolve_app_identifiers(cur, project_id, {r.app_id for r in records})
            by_app: dict[str, list] = defaultdict(list)
            for r in records:
                by_app[id_to_uuid[r.app_id]].append(r)
            endpoint_maps = {
                app_uuid: discover_endpoints(cur, app_uuid, recs)
                for app_uuid, recs in by_app.items()
            }

    client = clickhouse()
    ensure_clickhouse_schema(client)
    total = 0
    for app_uuid, recs in by_app.items():
        emap = endpoint_maps[app_uuid]
        rows = []
        for r in recs:
            method = r.method.upper()
            rows.append((
                r.timestamp, app_uuid, project_id, emap.get((method, r.path), ""),
                r.environment, method, r.path, r.status_code, r.response_time_ms,
                r.request_size, r.response_size, r.ip_address, r.user_agent,
                (r.consumer_id or "")[:256], (r.consumer_name or "")[:256],
                (r.consumer_group or "")[:256],
                _safe_payload(r.request_payload), _safe_payload(r.response_payload),
            ))
        client.execute(
            f"INSERT INTO api_requests ({', '.join(REQUEST_COLUMNS)}) VALUES",
            rows,
        )
        total += len(rows)
    return total


def handle_logs(project_id: str, project_slug: str, records) -> int:
    if len(records) > MAX_BATCH_SIZE:
        raise IngestError(422, "validation_error", f"Batch size exceeds maximum of {MAX_BATCH_SIZE}")
    if not records:
        return 0

    validate_project_slug(project_slug, {r.project_slug for r in records})

    with pg_conn() as conn:
        with conn.cursor() as cur:
            id_to_uuid = resolve_app_identifiers(cur, project_id, {r.app_id for r in records})
            by_app: dict[str, list] = defaultdict(list)
            for r in records:
                by_app[id_to_uuid[r.app_id]].append(r)

    client = clickhouse()
    ensure_clickhouse_schema(client)
    total = 0
    for app_uuid, recs in by_app.items():
        rows = []
        for r in recs:
            rows.append((
                r.timestamp, app_uuid, project_id,
                (r.environment or "production").strip().lower(),
                _normalize_log_level(r.level),
                _safe_log_text(r.message, limit=MAX_LOG_MESSAGE_CHARS),
                _safe_log_text(r.logger_name, limit=256),
                _safe_log_text(r.payload, limit=MAX_LOG_PAYLOAD_CHARS),
                json.dumps(_sanitize_log_attributes(r.attributes), separators=(",", ":")),
            ))
        client.execute(
            f"INSERT INTO api_logs ({', '.join(LOG_COLUMNS)}) VALUES",
            rows,
        )
        total += len(rows)
    return total
