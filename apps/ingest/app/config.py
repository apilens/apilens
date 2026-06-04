"""Environment-driven config for the standalone ingest service.

Reads the SAME env vars as apps/api so prod wiring is unchanged — Postgres via
APILENS_POSTGRES_URL (or POSTGRES_* parts) and ClickHouse via
APILENS_CLICKHOUSE_URL (or CLICKHOUSE_* parts).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import unquote, urlparse


@dataclass(frozen=True)
class PostgresConfig:
    host: str
    port: int
    dbname: str
    user: str
    password: str


@dataclass(frozen=True)
class ClickHouseConfig:
    host: str
    port: int
    database: str
    user: str
    password: str
    secure: bool
    verify: bool


def _first(*names: str, default: str = "") -> str:
    for n in names:
        v = os.environ.get(n, "").strip()
        if v:
            return v
    return default


def load_postgres() -> PostgresConfig:
    url = _first("APILENS_POSTGRES_URL", "APILENS_POSTGRES_URL_NON_POOLING", "DATABASE_URL")
    if url:
        p = urlparse(url)
        return PostgresConfig(
            host=p.hostname or "localhost",
            port=p.port or 5432,
            dbname=(p.path or "/apilens").lstrip("/") or "apilens",
            user=unquote(p.username or "apilens"),
            password=unquote(p.password or ""),
        )
    return PostgresConfig(
        host=_first("APILENS_POSTGRES_HOST", "POSTGRES_HOST", default="localhost"),
        port=int(_first("APILENS_POSTGRES_PORT", "POSTGRES_PORT", default="5432")),
        dbname=_first("APILENS_POSTGRES_DATABASE", "POSTGRES_DB", default="apilens"),
        user=_first("APILENS_POSTGRES_USER", "POSTGRES_USER", default="apilens"),
        password=_first("APILENS_POSTGRES_PASSWORD", "POSTGRES_PASSWORD", default=""),
    )


def load_clickhouse() -> ClickHouseConfig:
    url = _first("APILENS_CLICKHOUSE_URL", "CLICKHOUSE_URL")
    if url:
        p = urlparse(url)
        secure = p.scheme in ("clickhouses", "https")
        return ClickHouseConfig(
            host=p.hostname or "localhost",
            port=p.port or (9440 if secure else 9000),
            database=(p.path or "/apilens").lstrip("/") or "apilens",
            user=unquote(p.username or "default"),
            password=unquote(p.password or ""),
            secure=secure,
            verify=_first("APILENS_CLICKHOUSE_VERIFY", default="True").lower() in ("true", "1", "yes"),
        )
    return ClickHouseConfig(
        host=_first("APILENS_CLICKHOUSE_HOST", "CLICKHOUSE_HOST", default="localhost"),
        port=int(_first("APILENS_CLICKHOUSE_PORT", "CLICKHOUSE_PORT", default="9000")),
        database=_first("APILENS_CLICKHOUSE_DATABASE", "CLICKHOUSE_DATABASE", default="apilens"),
        user=_first("APILENS_CLICKHOUSE_USER", "CLICKHOUSE_USER", default="default"),
        password=_first("APILENS_CLICKHOUSE_PASSWORD", "CLICKHOUSE_PASSWORD", default=""),
        secure=False,
        verify=True,
    )


MAX_BATCH_SIZE = 1000
