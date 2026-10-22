"""Runtime configuration, read from APILENS_AI_* environment variables."""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Service settings. Every field can be overridden by env, e.g. APILENS_AI_LOG_LEVEL."""

    model_config = SettingsConfigDict(env_prefix="APILENS_AI_", extra="ignore")

    api_base_url: str = "http://apilens:8080"
    log_level: Literal["debug", "info", "warning", "error"] = "info"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings, loaded once."""
    return Settings()
