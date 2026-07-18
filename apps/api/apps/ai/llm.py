"""Central LLM configuration for every AI feature.

Uses Agno's LiteLLM model so the provider is swappable from config alone —
OpenAI, Anthropic, Gemini, Azure, a self-hosted LiteLLM proxy gateway, etc.
Change the model with one env var; the code never names a provider.

Config (settings, from env):
  APILENS_AI_MODEL     LiteLLM model id. Examples:
                         gpt-4o-mini · gpt-4o · openai/gpt-4o
                         anthropic/claude-sonnet-5 · gemini/gemini-2.0-flash
                       Prefix with "provider/" when it's ambiguous.
  APILENS_AI_API_KEY   The key for that provider (or a LiteLLM proxy key).
  APILENS_AI_BASE_URL  Optional. Point at a LiteLLM proxy gateway
                       (e.g. http://localhost:4000) to route/switch models
                       centrally. When set, the key is the proxy's key.

LiteLLM also auto-reads provider env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY,
GEMINI_API_KEY …); if one of those is present AI is considered enabled even
without APILENS_AI_API_KEY.
"""

from __future__ import annotations

import os

_PROVIDER_ENV_KEYS = (
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
    "AZURE_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "COHERE_API_KEY",
)

DEFAULT_MODEL = "gpt-4o-mini"
_MAX_TOKENS = 4096


def _setting(name: str, default: str = "") -> str:
    from django.conf import settings

    return str(getattr(settings, name, "") or default)


def ai_enabled() -> bool:
    """True when a model can be built: an explicit APILens key, a proxy
    gateway base URL, or any provider key already in the environment."""
    if _setting("AI_API_KEY") or _setting("AI_BASE_URL"):
        return True
    return any(os.environ.get(k) for k in _PROVIDER_ENV_KEYS)


def model_id() -> str:
    return _setting("AI_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL


def structured(run, expected_type):
    """Return an Agno run's structured content, or raise a clear error.

    With models that lack native structured-output support, Agno parses the
    schema out of the text; a malformed response yields a raw string instead
    of the pydantic object. Callers get a legible failure rather than a bare
    AttributeError deep in the pipeline."""
    content = getattr(run, "content", None)
    if isinstance(content, expected_type):
        return content
    raise RuntimeError(
        f"AI returned an unparseable {expected_type.__name__} "
        f"(got {type(content).__name__}); try a stronger model via APILENS_AI_MODEL"
    )


def build_model():
    """Return (model_id, Agno LiteLLM model). Raises RuntimeError when AI is
    not configured."""
    if not ai_enabled():
        raise RuntimeError(
            "AI is not configured: set APILENS_AI_API_KEY (and APILENS_AI_MODEL), "
            "or point APILENS_AI_BASE_URL at a LiteLLM gateway."
        )
    from agno.models.litellm import LiteLLM

    mid = model_id()
    kwargs: dict = {"id": mid, "max_tokens": _MAX_TOKENS}
    api_key = _setting("AI_API_KEY")
    if api_key:
        kwargs["api_key"] = api_key
    base_url = _setting("AI_BASE_URL")
    if base_url:
        kwargs["api_base"] = base_url
    return mid, LiteLLM(**kwargs)
