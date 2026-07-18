"""Natural language → APILens filter DSL (Phase 3, the "Ask APILens" box).

The filter grammar is small and typed, which makes it a reliable compile
target: one structured Agno call, then server-side validation with the real
parser — an invalid translation is corrected once with the parser's error
message, and never reaches the client unvalidated.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from core.exceptions.base import ValidationError

logger = logging.getLogger(__name__)

_GRAMMAR = """Filter grammar (produce EXACTLY this syntax):
- Clauses joined by ";" are ANDed: `field:op:value;field:op:value`
- Comma separates OR values inside one clause: `method:is:GET,POST`
- Leading "-" negates a clause: `-env:is:dev`
- Fields and ops:
  app (slug)            is, not
  method                is, not          values GET POST PUT PATCH DELETE HEAD OPTIONS
  status (int)          is, not, gt, gte, lt, lte, between (between uses value `a,b`)
  status_class          is, not          values 1xx 2xx 3xx 4xx 5xx
  path                  is, not, contains, startswith, endswith
  latency (ms, int)     is, not, gt, gte, lt, lte, between
  env                   is, not
  consumer              is, not, contains
  req_size (bytes)      is, not, gt, gte, lt, lte, between
  resp_size (bytes)     is, not, gt, gte, lt, lte, between
  ip                    is, not, contains
  ua                    contains
  release               is, not, contains
Examples:
  "failed checkout calls" -> status_class:is:5xx;path:contains:checkout
  "slow requests from acme" -> latency:gt:1000;consumer:contains:acme
  "errors in v1.4.2 except health checks" -> status_class:is:4xx,5xx;release:is:v1.4.2;-path:contains:health
"""


class FilterTranslation(BaseModel):
    filter: str = Field(description="The canonical filter string, or empty if the question needs no filter")
    hours: int = Field(description="Time window in hours implied by the question (e.g. 'yesterday'→24, 'this week'→168); 0 if none implied")
    explanation: str = Field(description="One short sentence describing what the filter matches, for display under the search box")


def _agent():
    from agno.agent import Agent

    from .investigator import _build_model

    _model_id, model = _build_model()
    return Agent(
        model=model,
        output_schema=FilterTranslation,
        telemetry=False,
        description=(
            "Translate a user's natural-language question about their API traffic into "
            "the APILens filter DSL. Output only fields/ops from the grammar; never invent "
            "field names; prefer `contains` for fuzzy path/consumer references; leave "
            "filter empty when the question isn't a traffic filter.\n\n" + _GRAMMAR
        ),
    )


def translate(question: str) -> dict:
    """NL question → validated filter. Raises ValidationError when AI is not
    configured or the model can't produce a parseable filter."""
    from apps.projects.filters import parse_filter

    question = (question or "").strip()
    if not question:
        raise ValidationError("question is required")
    if len(question) > 500:
        raise ValidationError("question is too long")

    agent = _agent()
    run = agent.run(f"Question: {question}")
    result: FilterTranslation = run.content

    candidate = (result.filter or "").strip()
    if candidate:
        try:
            parse_filter(candidate)
        except ValidationError as exc:
            # One correction round with the real parser's complaint.
            retry = agent.run(
                f"Question: {question}\n"
                f"Your previous answer `{candidate}` failed validation: {exc.message}. "
                "Produce a corrected filter using only the documented fields and operators."
            )
            result = retry.content
            candidate = (result.filter or "").strip()
            if candidate:
                parse_filter(candidate)  # still invalid → surfaces as 422

    return {
        "filter": candidate,
        "hours": max(0, int(result.hours or 0)),
        "explanation": result.explanation or "",
    }
