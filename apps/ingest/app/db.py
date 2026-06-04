"""Database connections: a Postgres pool + a per-thread ClickHouse client.

Mirrors how apps/api connects (psycopg to Postgres, clickhouse_driver native to
ClickHouse) so the ingest service reads/writes the exact same stores.
"""

from __future__ import annotations

import contextlib
import threading

import psycopg2
from psycopg2.pool import ThreadedConnectionPool
from clickhouse_driver import Client

from .config import load_clickhouse, load_postgres

_pg_pool: ThreadedConnectionPool | None = None
_pg_lock = threading.Lock()
_ch_local = threading.local()


def init_postgres_pool(minconn: int = 1, maxconn: int = 10) -> None:
    global _pg_pool
    with _pg_lock:
        if _pg_pool is not None:
            return
        c = load_postgres()
        _pg_pool = ThreadedConnectionPool(
            minconn,
            maxconn,
            host=c.host,
            port=c.port,
            dbname=c.dbname,
            user=c.user,
            password=c.password,
        )


@contextlib.contextmanager
def pg_conn():
    if _pg_pool is None:
        init_postgres_pool()
    assert _pg_pool is not None
    conn = _pg_pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pg_pool.putconn(conn)


def clickhouse() -> Client:
    client = getattr(_ch_local, "client", None)
    if client is None:
        c = load_clickhouse()
        client = Client(
            host=c.host,
            port=c.port,
            database=c.database,
            user=c.user,
            password=c.password,
            secure=c.secure,
            verify=c.verify,
            settings={"use_numpy": False},
        )
        _ch_local.client = client
    return client
