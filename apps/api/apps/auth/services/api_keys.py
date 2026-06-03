"""Per-project API keys: create, list, revoke."""

import secrets

from core.exceptions.base import RateLimitError

from ..models import ApiKey
from ._constants import API_KEY_PREFIX, MAX_API_KEYS_PER_PROJECT, hash_token


class ApiKeyService:
    @staticmethod
    def create_key(project, name: str, app=None) -> tuple[str, ApiKey]:
        """Create an API key.

        Pass ``app`` to mint an app-scoped key: the server then derives both
        project and app from the key alone, so SDKs only need the key. Omit it
        for a legacy project-scoped key (app identified per-record via app_id).
        """
        active_count = ApiKey.objects.for_project(project).count()
        if active_count >= MAX_API_KEYS_PER_PROJECT:
            raise RateLimitError(
                f"Maximum of {MAX_API_KEYS_PER_PROJECT} active API keys allowed per project"
            )

        raw_secret = secrets.token_urlsafe(40)
        raw_key = f"{API_KEY_PREFIX}{raw_secret}"
        prefix = raw_key[:16]

        api_key = ApiKey.objects.create(
            project=project,
            app=app,
            key_hash=hash_token(raw_key),
            prefix=prefix,
            name=name[:100],
        )
        return raw_key, api_key

    @staticmethod
    def list_keys_for_app(app) -> list[ApiKey]:
        return list(ApiKey.objects.active().filter(app=app).order_by("-created_at"))

    @staticmethod
    def list_keys(project) -> list[ApiKey]:
        return list(ApiKey.objects.for_project(project).order_by("-created_at"))

    @staticmethod
    def revoke_key(project, key_id: str) -> bool:
        updated = ApiKey.objects.filter(
            id=key_id, project=project, is_revoked=False
        ).update(is_revoked=True)
        return updated > 0

    @staticmethod
    def revoke_all_for_project(project) -> int:
        return ApiKey.objects.filter(
            project=project, is_revoked=False
        ).update(is_revoked=True)
