"""GitHub App client: app JWT → cached installation tokens → REST calls.

Auth model (docs.github.com, "Authenticating as a GitHub App installation"):
a short-lived RS256 JWT (iss = app id) mints an installation access token via
POST /app/installations/{id}/access_tokens; tokens live 1 hour. We cache them
in-process per installation and refresh 5 minutes early. Tokens and the app
private key are never persisted to the database.

Every helper raises GitHubApiError with the upstream status so callers can
fail soft (suspect commits and repo pickers must never break a page) and
lazily mark installations revoked on 401/404.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

import httpx
import jwt
from django.conf import settings

DEFAULT_API_BASE = "https://api.github.com"
DEFAULT_WEB_BASE = "https://github.com"

# App JWTs may live up to 10 minutes; keep it short, allow clock drift.
_JWT_TTL_SECONDS = 300
_JWT_DRIFT_SECONDS = 30

# Installation tokens last 1h; refresh early so in-flight calls never expire.
_TOKEN_EARLY_REFRESH_SECONDS = 300


class GitHubApiError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"GitHub API {status_code}: {detail}")


class GitHubNotConfigured(Exception):
    """The server has no GitHub App credentials configured."""


@dataclass(frozen=True)
class _CachedToken:
    token: str
    expires_at: float  # epoch seconds


_token_cache: dict[int, _CachedToken] = {}
_token_lock = threading.Lock()


def _app_credentials() -> tuple[str, str]:
    app_id = str(getattr(settings, "GITHUB_APP_ID", "") or "")
    private_key = str(getattr(settings, "GITHUB_APP_PRIVATE_KEY", "") or "")
    if not app_id or not private_key:
        raise GitHubNotConfigured(
            "Set APILENS_GITHUB_APP_ID and APILENS_GITHUB_APP_PRIVATE_KEY"
        )
    return app_id, private_key


def api_base(base_url: str = "") -> str:
    """API root for github.com or a GHES host ("" → github.com)."""
    host = (base_url or "").strip().rstrip("/")
    if not host:
        return DEFAULT_API_BASE
    return f"{host}/api/v3"


def web_base(base_url: str = "") -> str:
    host = (base_url or "").strip().rstrip("/")
    return host or DEFAULT_WEB_BASE


def app_jwt() -> str:
    """Short-lived RS256 JWT authenticating as the GitHub App itself."""
    app_id, private_key = _app_credentials()
    now = int(time.time())
    payload = {
        "iat": now - _JWT_DRIFT_SECONDS,
        "exp": now + _JWT_TTL_SECONDS,
        "iss": app_id,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")


def _request(
    method: str,
    url: str,
    *,
    token: str,
    json_body: dict | None = None,
    params: dict | None = None,
) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "apilens-integrations",
    }
    with httpx.Client(timeout=10.0) as client:
        resp = client.request(method, url, headers=headers, json=json_body, params=params)
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("message", resp.text[:200])
        except Exception:
            detail = resp.text[:200]
        raise GitHubApiError(resp.status_code, str(detail))
    return resp


def installation_token(installation_id: int, base_url: str = "") -> str:
    """A valid installation access token, cached until ~5 min before expiry."""
    now = time.time()
    with _token_lock:
        cached = _token_cache.get(installation_id)
        if cached and cached.expires_at - _TOKEN_EARLY_REFRESH_SECONDS > now:
            return cached.token

    resp = _request(
        "POST",
        f"{api_base(base_url)}/app/installations/{installation_id}/access_tokens",
        token=app_jwt(),
    )
    data = resp.json()
    token = data["token"]
    # expires_at is ISO8601; parse defensively and fall back to the 1h contract.
    try:
        from datetime import datetime

        expires_at = datetime.fromisoformat(
            str(data.get("expires_at", "")).replace("Z", "+00:00")
        ).timestamp()
    except Exception:
        expires_at = now + 3600
    with _token_lock:
        _token_cache[installation_id] = _CachedToken(token=token, expires_at=expires_at)
    return token


def drop_cached_token(installation_id: int) -> None:
    with _token_lock:
        _token_cache.pop(installation_id, None)


# ── App-authenticated calls ─────────────────────────────────────────────────

def get_installation(installation_id: int, base_url: str = "") -> dict:
    """Fetch an installation AS THE APP — the anti-spoofing check: the id must
    exist and belong to our app, and the account comes from GitHub, never the
    client."""
    resp = _request(
        "GET",
        f"{api_base(base_url)}/app/installations/{installation_id}",
        token=app_jwt(),
    )
    return resp.json()


# ── Installation-authenticated calls ────────────────────────────────────────

def list_installation_repos(installation_id: int, base_url: str = "", limit: int = 200) -> list[dict]:
    """Repositories the installation can access (paginated, capped)."""
    token = installation_token(installation_id, base_url)
    repos: list[dict] = []
    page = 1
    while len(repos) < limit:
        resp = _request(
            "GET",
            f"{api_base(base_url)}/installation/repositories",
            token=token,
            params={"per_page": 100, "page": page},
        )
        batch = resp.json().get("repositories", [])
        repos.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return repos[:limit]


def get_file_content(
    installation_id: int,
    full_name: str,
    path: str,
    *,
    ref: str = "",
    max_bytes: int = 40_000,
    base_url: str = "",
) -> str:
    """Raw file content at `ref` (branch or commit sha), size-capped.

    Used by the AI investigator's code-reading tool; returns "" for binary or
    oversized files rather than erroring."""
    import base64

    token = installation_token(installation_id, base_url)
    params: dict = {}
    if ref:
        params["ref"] = ref
    resp = _request(
        "GET",
        f"{api_base(base_url)}/repos/{full_name}/contents/{path}",
        token=token,
        params=params,
    )
    data = resp.json()
    if not isinstance(data, dict) or data.get("type") != "file":
        return ""
    if int(data.get("size") or 0) > max_bytes:
        return ""
    try:
        return base64.b64decode(data.get("content", "")).decode("utf-8", errors="replace")
    except Exception:
        return ""


def list_commits_for_path(
    installation_id: int,
    full_name: str,
    path: str,
    *,
    sha: str = "",
    until: str = "",
    per_page: int = 5,
    base_url: str = "",
) -> list[dict]:
    """Commits touching `path`, newest first. `sha` scopes history to the code
    that was actually running (Phase 0's stamped commit); `until` is the
    fallback time-window bound."""
    token = installation_token(installation_id, base_url)
    params: dict = {"path": path, "per_page": per_page}
    if sha:
        params["sha"] = sha
    elif until:
        params["until"] = until
    resp = _request(
        "GET",
        f"{api_base(base_url)}/repos/{full_name}/commits",
        token=token,
        params=params,
    )
    return resp.json()
