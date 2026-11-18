"""Database spans: obfuscation, one test per driver, and the disable option."""

import asyncio
import io
import sys
import types

import pytest

from apilens.client import db_spans, spans
from apilens.client.db_spans import MAX_STATEMENT_CHARS, obfuscate_statement, statement_operation
from apilens.client.middleware import ApiLensWSGIMiddleware
from apilens.client.trace import begin_request_trace, end_request_trace

from conftest import StubClient

SECRET = "s3cr3t-value"


@pytest.fixture
def recorder(monkeypatch):
    """Spans configured to a fresh stub client with db spans on."""
    client = StubClient()
    monkeypatch.setattr(spans, "_recorder", None)
    spans.configure_spans(client, app_id="orders", instrument_http=False, instrument_db=True)
    yield client
    db_spans.set_db_spans_enabled(False)
    spans._recorder = None


@pytest.fixture
def in_request():
    trace_id, span_id, _parent, token = begin_request_trace(None)
    yield trace_id, span_id
    end_request_trace(token)


def _db(client):
    return [s for s in client.spans if s.kind == "db"]


def _assert_no_literals(span):
    for value in [span.name, *span.attributes.values()]:
        assert SECRET not in value
        assert "4242" not in value


# ── Obfuscation ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "sql,expected",
    [
        ("SELECT * FROM users WHERE email = 'a@example.com'", "SELECT * FROM users WHERE email = ?"),
        ("SELECT * FROM t WHERE id = 42 AND score > 3.5e2", "SELECT * FROM t WHERE id = ? AND score > ?"),
        ("SELECT * FROM t WHERE name = 'it''s' -- by 'bob'\nLIMIT 10", "SELECT * FROM t WHERE name = ? LIMIT ?"),
        ("SELECT /* id=7 */ col1 FROM t2", "SELECT col1 FROM t2"),
        ("SELECT $$raw 'x' 99$$, $tag$body$tag$", "SELECT ?, ?"),
        ("SELECT E'esc\\'aped', X'ff', 0xDEAD", "SELECT ?, ?, ?"),
        ("SELECT * FROM t WHERE id in (1, 2, 3)", "SELECT * FROM t WHERE id IN (?)"),
        ("INSERT INTO t VALUES (1, 'a')", "INSERT INTO t VALUES (?, ?)"),
        ('SELECT "t"."col 1" FROM "t" WHERE a = $1 AND b = %s AND c = %(c)s AND d = :d AND e = ?',
         'SELECT "t"."col 1" FROM "t" WHERE a = $1 AND b = %s AND c = %(c)s AND d = :d AND e = ?'),
        ("SELECT ARRAY[1, 2] FROM t", "SELECT ARRAY[?, ?] FROM t"),
        ("SELECT 'unterminated " + SECRET, "SELECT ?"),
    ],
)
def test_obfuscate_replaces_literals(sql, expected):
    assert obfuscate_statement(sql) == expected


def test_mysql_double_quotes_are_literals():
    assert obfuscate_statement('SELECT * FROM `t` WHERE a = "x"', "mysql") == "SELECT * FROM `t` WHERE a = ?"
    assert obfuscate_statement('SELECT "a" FROM t', "postgresql") == 'SELECT "a" FROM t'


def test_obfuscate_caps_at_2_kib():
    sql = "SELECT " + ", ".join(f"col_{i}" for i in range(2000)) + " FROM t"
    out = obfuscate_statement(sql)
    assert len(out) == MAX_STATEMENT_CHARS
    assert out.endswith("...")


def test_operation_is_first_keyword():
    assert statement_operation(obfuscate_statement("/* c */ insert into t values (1)")) == "INSERT"
    assert statement_operation("") == ""


# ── Span lifecycle ──────────────────────────────────────────────────────────


def test_no_span_outside_a_request(recorder):
    span = db_spans.start_db_span("sqlite", "SELECT 1")
    assert span is None


def test_nested_layers_record_once(recorder, in_request):
    outer = db_spans.start_db_span("postgresql", "SELECT 1")
    assert db_spans.start_db_span("postgresql", "SELECT 1") is None
    db_spans.finish_db_span(outer)
    inner_after = db_spans.start_db_span("postgresql", "SELECT 2")
    db_spans.finish_db_span(inner_after)
    assert [s.attributes["db.statement"] for s in _db(recorder)] == ["SELECT ?", "SELECT ?"]


def test_long_statement_survives_attribute_cap(recorder, in_request):
    sql = "SELECT " + ", ".join(f"col_{i}" for i in range(400)) + " FROM t"
    db_spans.finish_db_span(db_spans.start_db_span("sqlite", sql))
    (span,) = _db(recorder)
    assert len(span.attributes["db.statement"]) > 512
    assert len(span.name) <= 256


# ── SQLAlchemy (sqlite) ─────────────────────────────────────────────────────


def test_sqlalchemy_statements_become_db_spans(recorder, in_request):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    trace_id, span_id = in_request
    engine = sqlalchemy.create_engine("sqlite://")
    with engine.connect() as conn:
        conn.execute(sqlalchemy.text("CREATE TABLE cards (id INTEGER, number TEXT)"))
        conn.execute(sqlalchemy.text(f"INSERT INTO cards VALUES (1, '4242 {SECRET}')"))
        conn.execute(sqlalchemy.text("SELECT number FROM cards WHERE id = :id"), {"id": 4242})
        with pytest.raises(sqlalchemy.exc.OperationalError):
            conn.execute(sqlalchemy.text(f"SELECT * FROM missing WHERE x = '{SECRET}'"))

    got = _db(recorder)
    assert [s.attributes["db.operation"] for s in got] == ["CREATE", "INSERT", "SELECT", "SELECT"]
    assert got[1].attributes["db.statement"] == "INSERT INTO cards VALUES (?, ?)"
    for span in got:
        _assert_no_literals(span)
        assert span.attributes["db.system"] == "sqlite"
        assert span.trace_id == trace_id and span.parent_span_id == span_id
        assert span.duration_ms >= 0
    assert [s.status for s in got] == ["ok", "ok", "ok", "error"]
    assert got[3].attributes["error.type"].endswith("OperationalError")


# ── Django (sqlite) ─────────────────────────────────────────────────────────


@pytest.fixture
def django_connection():
    django = pytest.importorskip("django")
    from django.conf import settings

    if not settings.configured:
        settings.configure(DEBUG=False, ALLOWED_HOSTS=["*"])
        django.setup()
    from django.db.utils import ConnectionHandler

    handler = ConnectionHandler({"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}})
    conn = handler["default"]
    yield conn
    conn.close()


def test_django_statements_become_db_spans(django_connection, recorder, in_request):
    trace_id, _ = in_request
    with django_connection.cursor() as cursor:
        cursor.execute("CREATE TABLE cards (id integer, number text)")
        cursor.execute("INSERT INTO cards VALUES (%s, %s)", [1, SECRET])
        cursor.execute(f"SELECT number FROM cards WHERE number = '{SECRET}' AND id = 4242")
        with pytest.raises(Exception):
            cursor.execute("SELECT * FROM missing")

    got = _db(recorder)
    assert len(got) == 4
    assert got[2].attributes["db.statement"] == "SELECT number FROM cards WHERE number = ? AND id = ?"
    for span in got:
        _assert_no_literals(span)
        assert span.attributes["db.system"] == "sqlite"
        assert span.trace_id == trace_id
    assert got[3].status == "error"
    # One wrapper per connection, however often spans are reconfigured.
    db_spans._installed.discard("django")
    db_spans.instrument_databases()
    assert django_connection.execute_wrappers.count(db_spans._django_wrapper) == 1


# ── psycopg (fake) ──────────────────────────────────────────────────────────


@pytest.fixture
def fake_psycopg(monkeypatch):
    module = types.ModuleType("psycopg")

    class Cursor:
        def __init__(self):
            self.ran = []

        def execute(self, query, params=None, *, prepare=None):
            if "boom" in str(query):
                raise RuntimeError("syntax error near " + SECRET)
            self.ran.append((query, params))
            return self

        def executemany(self, query, params_seq):
            self.ran.append((query, list(params_seq)))

    class AsyncCursor:
        async def execute(self, query, params=None):
            return self

        async def executemany(self, query, params_seq):
            return None

    module.Cursor = Cursor
    module.AsyncCursor = AsyncCursor
    monkeypatch.setitem(sys.modules, "psycopg", module)
    assert db_spans._patch_psycopg()
    assert db_spans._patch_psycopg()  # idempotent: no double wrapping
    return module


def test_psycopg_cursor_spans(recorder, in_request, fake_psycopg):
    cur = fake_psycopg.Cursor()
    cur.execute(f"SELECT * FROM cards WHERE number = '{SECRET}'", (4242,))
    cur.executemany("INSERT INTO cards VALUES (%s)", [(SECRET,)])
    with pytest.raises(RuntimeError):
        cur.execute("boom 4242")
    asyncio.run(fake_psycopg.AsyncCursor().execute("UPDATE cards SET n = 4242"))

    assert cur.ran[0] == (f"SELECT * FROM cards WHERE number = '{SECRET}'", (4242,))  # driver untouched
    got = _db(recorder)
    assert [s.attributes["db.operation"] for s in got] == ["SELECT", "INSERT", "BOOM", "UPDATE"]
    assert [s.status for s in got] == ["ok", "ok", "error", "ok"]
    for span in got:
        _assert_no_literals(span)
        assert span.attributes["db.system"] == "postgresql"


# ── asyncpg (fake) ──────────────────────────────────────────────────────────


@pytest.fixture
def fake_asyncpg(monkeypatch):
    package = types.ModuleType("asyncpg")
    connection = types.ModuleType("asyncpg.connection")

    class Connection:
        async def execute(self, query, *args, timeout=None):
            return "OK"

        async def executemany(self, command, args, *, timeout=None):
            return None

        async def fetch(self, query, *args, timeout=None):
            if "missing" in query:
                raise LookupError("relation missing")
            return [{"n": 1}]

        async def fetchrow(self, query, *args, timeout=None):
            return {"n": 1}

        async def fetchval(self, query, *args, column=0, timeout=None):
            return 1

    connection.Connection = Connection
    package.connection = connection
    monkeypatch.setitem(sys.modules, "asyncpg", package)
    monkeypatch.setitem(sys.modules, "asyncpg.connection", connection)
    assert db_spans._patch_asyncpg()
    return Connection


def test_asyncpg_connection_spans(recorder, fake_asyncpg):
    async def handler():
        trace_id, _span_id, _parent, token = begin_request_trace(None)
        try:
            conn = fake_asyncpg()
            await conn.execute(f"DELETE FROM cards WHERE n = '{SECRET}'")
            await conn.executemany("INSERT INTO cards VALUES ($1)", [(SECRET,)])
            assert await conn.fetch("SELECT * FROM cards WHERE id = $1", 4242) == [{"n": 1}]
            await conn.fetchrow("SELECT n FROM cards LIMIT 4242")
            await conn.fetchval("SELECT count(*) FROM cards")
            with pytest.raises(LookupError):
                await conn.fetch("SELECT * FROM missing")
            return trace_id
        finally:
            end_request_trace(token)

    trace_id = asyncio.run(handler())
    got = _db(recorder)
    assert len(got) == 6
    assert got[2].attributes["db.statement"] == "SELECT * FROM cards WHERE id = $1"
    assert got[5].status == "error" and got[5].attributes["error.type"] == "builtins.LookupError"
    for span in got:
        _assert_no_literals(span)
        assert span.trace_id == trace_id


# ── Disable option ──────────────────────────────────────────────────────────


def _run_wsgi_request(client, **options):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    engine = sqlalchemy.create_engine("sqlite://")

    def app(environ, start_response):
        with engine.connect() as conn:
            conn.execute(sqlalchemy.text("SELECT 4242"))
        start_response("200 OK", [("Content-Type", "application/json")])
        return [b"{}"]

    mw = ApiLensWSGIMiddleware(app, client, app_id="orders", capture_logs="off", **options)
    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": "/cards",
        "QUERY_STRING": "",
        "SERVER_NAME": "example.com",
        "SERVER_PORT": "80",
        "HTTP_HOST": "example.com",
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(b""),
    }
    b"".join(mw(environ, lambda status, headers, exc_info=None: None))
    return mw


@pytest.fixture
def reset_spans(monkeypatch):
    monkeypatch.setattr(spans, "_recorder", None)
    monkeypatch.delenv("APILENS_CAPTURE_DB_SPANS", raising=False)
    monkeypatch.delenv("APILENS_CAPTURE_SPANS", raising=False)
    yield
    db_spans.set_db_spans_enabled(False)
    spans._recorder = None


def test_db_spans_on_by_default_with_spans(reset_spans):
    client = StubClient()
    mw = _run_wsgi_request(client)
    assert mw.capture_db_spans is True
    got = _db(client)
    assert len(got) == 1 and got[0].attributes["db.statement"] == "SELECT ?"
    server = [s for s in client.spans if s.kind == "server"]
    assert server and got[0].parent_span_id == server[0].span_id


def test_capture_db_spans_false_disables(reset_spans):
    client = StubClient()
    mw = _run_wsgi_request(client, capture_db_spans=False)
    assert mw.capture_db_spans is False
    assert _db(client) == []
    assert any(s.kind == "server" for s in client.spans)


def test_capture_db_spans_env_disables(reset_spans, monkeypatch):
    monkeypatch.setenv("APILENS_CAPTURE_DB_SPANS", "false")
    client = StubClient()
    _run_wsgi_request(client)
    assert _db(client) == []


def test_capture_spans_false_turns_db_spans_off(reset_spans):
    client = StubClient()
    mw = _run_wsgi_request(client, capture_spans=False)
    assert mw.capture_db_spans is False
    assert _db(client) == []
