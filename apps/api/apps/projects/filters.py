"""
Unified filter engine for ClickHouse ``api_requests`` queries.

A *filter* is a compact, human-typable string of AND-combined predicates:

    field:op:value ; field:op:value ; ...

* ``value`` may be comma-separated for multi-value (OR within a single field).
* A leading ``-`` on the field negates the predicate (``-env:is:dev``).
* Typed shorthands accepted by the frontend (``>=``, ``~`` …) are normalised to
  canonical ops there; this parser only sees canonical ops.

The same grammar backs the URL state, the frontend FilterBar, and this builder —
so ``FIELD_REGISTRY`` here and ``schema.ts`` on the web side are one contract in
two languages and must be kept in lock-step.

Only ``parse_filter`` (string -> predicates) and ``build_where`` (predicates ->
parameterised SQL fragment) are public. The builder reuses the existing
``%(key)s`` placeholder convention so callers splice the fragment straight into
their ``filters: list[str]`` + ``params: dict`` query assembly.
"""

from __future__ import annotations

from dataclasses import dataclass

from core.exceptions.base import ValidationError

# ── Field registry ────────────────────────────────────────────────────────
# type drives which operators/coercion apply:
#   enum   – fixed value set, equality/IN only
#   int    – integer comparisons
#   number – float comparisons (ms, bytes use int but share number ops)
#   string – text, supports substring/prefix/suffix matching
#
# Keep in lock-step with apps/web/src/app/projects/[slug]/_shared/filters/schema.ts

HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"]

# Canonical operators.
SET_OPS = {"is", "not"}                                  # equality / IN
NUM_OPS = {"is", "not", "gt", "gte", "lt", "lte", "between"}
STR_OPS = {"is", "not", "contains", "startswith", "endswith"}


@dataclass(frozen=True)
class FieldSpec:
    column: str
    type: str                       # enum | int | string
    ops: set[str]
    values: list[str] | None = None  # allowed values for enum fields


FIELD_REGISTRY: dict[str, FieldSpec] = {
    # `app` filters on app_id, but the frontend sends app *slugs*; the service
    # remaps slugs -> ids before build_where (see get_project_requests).
    "app": FieldSpec("app_id", "string", SET_OPS),
    "method": FieldSpec("method", "enum", SET_OPS, HTTP_METHODS),
    "status": FieldSpec("status_code", "int", NUM_OPS),
    "status_class": FieldSpec("status_code", "enum", SET_OPS, STATUS_CLASSES),
    "path": FieldSpec("path", "string", STR_OPS),
    "latency": FieldSpec("response_time_ms", "int", NUM_OPS),
    "env": FieldSpec("environment", "enum", SET_OPS),
    "consumer": FieldSpec("consumer_id", "string", {"is", "not", "contains"}),
    "req_size": FieldSpec("request_size", "int", {"is", "not", "gt", "gte", "lt", "lte", "between"}),
    "resp_size": FieldSpec("response_size", "int", {"is", "not", "gt", "gte", "lt", "lte", "between"}),
    "ip": FieldSpec("ip_address", "string", {"is", "not", "contains"}),
    "ua": FieldSpec("user_agent", "string", {"contains"}),
}

# status class -> (min inclusive, max exclusive) on status_code.
_STATUS_CLASS_RANGE = {
    "1xx": (100, 200),
    "2xx": (200, 300),
    "3xx": (300, 400),
    "4xx": (400, 500),
    "5xx": (500, 600),
}

_SCALAR_SQL_OP = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}


@dataclass(frozen=True)
class Predicate:
    field: str
    op: str
    values: list[str]
    negate: bool = False


# ── Parsing ───────────────────────────────────────────────────────────────

def parse_filter(raw: str | None) -> list[Predicate]:
    """Parse a canonical filter string into validated predicates.

    Raises ``ValidationError`` (HTTP 422) on unknown field/op or bad value.
    Returns ``[]`` for empty/blank input.
    """
    if not raw or not raw.strip():
        return []

    predicates: list[Predicate] = []
    for chunk in raw.split(";"):
        token = chunk.strip()
        if not token:
            continue

        negate = token.startswith("-")
        if negate:
            token = token[1:]

        # Split into field, op, value on the first two colons so values may
        # themselves contain ':'.
        parts = token.split(":", 2)
        if len(parts) != 3:
            raise ValidationError(f"Invalid filter clause: {chunk!r}. Expected field:op:value.")
        field, op, value = parts[0].strip(), parts[1].strip().lower(), parts[2]

        spec = FIELD_REGISTRY.get(field)
        if spec is None:
            raise ValidationError(f"Unknown filter field: {field!r}.")
        if op not in spec.ops:
            raise ValidationError(f"Operator {op!r} is not valid for field {field!r}.")

        values = [v.strip() for v in value.split(",") if v.strip()]
        if not values:
            raise ValidationError(f"Filter {field!r} needs a value.")

        if op == "between" and len(values) != 2:
            raise ValidationError(f"Filter {field!r} with 'between' needs exactly two values.")
        if op in _SCALAR_SQL_OP and len(values) != 1:
            raise ValidationError(f"Filter {field!r} with {op!r} takes a single value.")

        _validate_values(field, spec, values)
        predicates.append(Predicate(field=field, op=op, values=values, negate=negate))

    return predicates


def _validate_values(field: str, spec: FieldSpec, values: list[str]) -> None:
    if spec.type == "int":
        for v in values:
            try:
                float(v)
            except ValueError:
                raise ValidationError(f"Filter {field!r} expects a number, got {v!r}.")
    if spec.values is not None:
        allowed = {a.upper() for a in spec.values}
        for v in values:
            if v.upper() not in allowed:
                raise ValidationError(
                    f"Filter {field!r} value {v!r} is not one of: {', '.join(spec.values)}."
                )


# ── SQL building ──────────────────────────────────────────────────────────

def build_where(predicates: list[Predicate], params: dict, *, key_prefix: str = "flt") -> str:
    """Render predicates into a parameterised SQL fragment.

    Mutates ``params`` with collision-free ``%(key)s`` placeholders and returns
    a string of ``AND (...)`` clauses (empty string when there are no
    predicates) to splice into an existing WHERE assembly.
    """
    clauses: list[str] = []
    for idx, pred in enumerate(predicates):
        spec = FIELD_REGISTRY[pred.field]
        key = f"{key_prefix}{idx}"
        clause = _render(pred, spec, key, params)
        if pred.negate:
            clause = f"NOT ({clause})"
        clauses.append(f"AND ({clause})")
    return " ".join(clauses)


def _render(pred: Predicate, spec: FieldSpec, key: str, params: dict) -> str:
    col = spec.column

    # status_class expands to status_code range(s), OR-combined across values.
    if pred.field == "status_class":
        ranges = []
        for i, cls in enumerate(pred.values):
            lo, hi = _STATUS_CLASS_RANGE[cls.lower()]
            lo_key, hi_key = f"{key}_{i}_lo", f"{key}_{i}_hi"
            params[lo_key], params[hi_key] = lo, hi
            ranges.append(f"({col} >= %({lo_key})s AND {col} < %({hi_key})s)")
        return " OR ".join(ranges)

    op = pred.op

    if op in _SCALAR_SQL_OP:
        params[key] = _coerce(spec, pred.values[0])
        return f"{col} {_SCALAR_SQL_OP[op]} %({key})s"

    if op == "between":
        lo_key, hi_key = f"{key}_lo", f"{key}_hi"
        params[lo_key] = _coerce(spec, pred.values[0])
        params[hi_key] = _coerce(spec, pred.values[1])
        return f"{col} BETWEEN %({lo_key})s AND %({hi_key})s"

    if op in ("contains", "startswith", "endswith"):
        term = _like_escape(pred.values[0])
        pattern = {"contains": f"%{term}%", "startswith": f"{term}%", "endswith": f"%{term}"}[op]
        params[key] = pattern
        return f"lower({col}) LIKE lower(%({key})s)"

    # is / not -> equality or IN, across one or many values.
    coerced = [_coerce(spec, v) for v in pred.values]
    if len(coerced) == 1:
        params[key] = coerced[0]
        sql = f"{col} = %({key})s"
    else:
        placeholders = []
        for i, v in enumerate(coerced):
            k = f"{key}_{i}"
            params[k] = v
            placeholders.append(f"%({k})s")
        sql = f"{col} IN ({', '.join(placeholders)})"
    # 'not' is handled here (rather than via Predicate.negate) so multi-value
    # 'not' reads as NOT IN.
    if op == "not":
        sql = sql.replace(" = ", " != ", 1).replace(" IN (", " NOT IN (", 1)
    return sql


def _coerce(spec: FieldSpec, value: str):
    if spec.type == "int":
        f = float(value)
        return int(f) if f.is_integer() else f
    if spec.column == "method":
        return value.upper()
    return value


def _like_escape(value: str) -> str:
    # Escape LIKE wildcards in user input so 'contains' is literal.
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
