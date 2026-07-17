"""Code Link services: GitHub install lifecycle, code mappings, suspect commits.

See PHASE1_CODE_LINK_DESIGN.md for the model and edge-case matrix. Everything
that talks to GitHub fails soft — a broken integration must degrade the
Errors page to "no code context", never to an error.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
from datetime import datetime, timedelta, timezone

from django.conf import settings
from django.core import signing
from django.core.cache import cache

from core.exceptions.base import NotFoundError, ValidationError

from . import github_client
from .github_client import GitHubApiError, GitHubNotConfigured
from .models import CodeMapping, GitHubInstallation, Repository

logger = logging.getLogger(__name__)

_STATE_SALT = "integrations.github.install"
_STATE_MAX_AGE_SECONDS = 900

# CPython traceback frame incl. line number (fingerprint.py drops the line
# number on purpose; suspect commits and source links need it).
_FRAME_RE = re.compile(r'File "([^"]+)", line (\d+), in (\S+)')

_SUSPECT_MAX_FRAMES = 3
_SUSPECT_MAX_COMMITS = 5
_SUSPECT_MAX_AGE_DAYS = 365  # Sentry's documented cutoff
_SUSPECT_CACHE_SECONDS = 600


class GitHubIntegrationService:
    # ── Install flow ────────────────────────────────────────────────────

    @staticmethod
    def build_install_url(project, user) -> dict:
        """Install URL carrying signed state (see design doc: the state ties
        the eventual callback to this exact project + user, expiring in 15m)."""
        app_slug = str(getattr(settings, "GITHUB_APP_SLUG", "") or "")
        if not app_slug:
            raise ValidationError("GitHub App is not configured on this server")
        state = signing.dumps(
            {"project_id": str(project.id), "user_id": str(user.id)},
            salt=_STATE_SALT,
        )
        return {
            "url": f"{github_client.web_base()}/apps/{app_slug}/installations/new?state={state}",
            "state": state,
        }

    @staticmethod
    def complete_installation(project, user, installation_id, state: str) -> GitHubInstallation:
        """Finish the install flow.

        Defenses against a spoofed installation_id (GitHub docs warn the setup
        redirect's value is untrusted): the signed state must be unexpired and
        must name THIS project, and the installation must exist AND belong to
        our app (verified as the app; account details come from GitHub)."""
        try:
            payload = signing.loads(state, salt=_STATE_SALT, max_age=_STATE_MAX_AGE_SECONDS)
        except signing.BadSignature as exc:
            raise ValidationError("Invalid or expired installation state") from exc
        if payload.get("project_id") != str(project.id):
            raise ValidationError("Installation state does not match this project")

        try:
            installation_id = int(installation_id)
        except (TypeError, ValueError) as exc:
            raise ValidationError("installation_id must be an integer") from exc

        try:
            info = github_client.get_installation(installation_id)
        except GitHubNotConfigured as exc:
            raise ValidationError(str(exc)) from exc
        except GitHubApiError as exc:
            if exc.status_code == 404:
                raise ValidationError("Installation not found for this GitHub App") from exc
            raise ValidationError(f"GitHub verification failed: {exc.detail}") from exc

        account = info.get("account") or {}
        install, _created = GitHubInstallation.objects.update_or_create(
            project=project,
            installation_id=installation_id,
            defaults={
                "account_login": str(account.get("login") or "")[:256],
                "account_type": str(account.get("type") or "")[:32],
                "repository_selection": str(info.get("repository_selection") or "")[:16],
                "status": GitHubInstallation.Status.ACTIVE,
                "created_by": user,
            },
        )
        return install

    # ── Status / repos ──────────────────────────────────────────────────

    @staticmethod
    def get_status(project) -> dict:
        installs = list(
            GitHubInstallation.objects.filter(project=project).order_by("created_at")
        )
        repos = list(
            Repository.objects.filter(project=project)
            .select_related("installation")
            .order_by("full_name")
        )
        mappings = list(
            CodeMapping.objects.filter(app__project=project)
            .select_related("repository", "app")
            .order_by("app__slug", "-stack_trace_root")
        )
        return {
            "configured": bool(getattr(settings, "GITHUB_APP_SLUG", "")),
            "connected": any(
                i.status == GitHubInstallation.Status.ACTIVE for i in installs
            ),
            "installations": [
                {
                    "id": str(i.id),
                    "installation_id": i.installation_id,
                    "account_login": i.account_login,
                    "account_type": i.account_type,
                    "status": i.status,
                }
                for i in installs
            ],
            "repositories": [
                {
                    "id": str(r.id),
                    "full_name": r.full_name,
                    "default_branch": r.default_branch,
                    "is_active": r.is_active,
                    "account_login": r.installation.account_login,
                }
                for r in repos
            ],
            "code_mappings": [
                {
                    "id": str(m.id),
                    "app_slug": m.app.slug,
                    "repository_id": str(m.repository_id),
                    "repository": m.repository.full_name,
                    "stack_trace_root": m.stack_trace_root,
                    "source_root": m.source_root,
                    "branch": m.branch,
                }
                for m in mappings
            ],
        }

    @staticmethod
    def list_available_repos(project) -> list[dict]:
        """Union of repos across the project's active installations (the
        picker for linking). GitHub failures degrade to an empty list with a
        reason instead of erroring the settings page."""
        linked = {
            r.external_id
            for r in Repository.objects.filter(project=project, is_active=True)
        }
        out: list[dict] = []
        for install in GitHubInstallation.objects.filter(
            project=project, status=GitHubInstallation.Status.ACTIVE
        ):
            try:
                repos = github_client.list_installation_repos(
                    install.installation_id, install.base_url
                )
            except (GitHubApiError, GitHubNotConfigured) as exc:
                GitHubIntegrationService._maybe_mark_revoked(install, exc)
                logger.warning(
                    "listing repos failed for installation %s: %s",
                    install.installation_id, exc,
                )
                continue
            for repo in repos:
                out.append(
                    {
                        "installation_id": str(install.id),
                        "external_id": repo.get("id"),
                        "full_name": repo.get("full_name", ""),
                        "default_branch": repo.get("default_branch", "main"),
                        "private": bool(repo.get("private", True)),
                        "linked": repo.get("id") in linked,
                    }
                )
        out.sort(key=lambda r: r["full_name"])
        return out

    @staticmethod
    def link_repository(project, installation_pk: str, external_id: int, full_name: str,
                        default_branch: str, private: bool) -> Repository:
        install = GitHubInstallation.objects.filter(project=project, id=installation_pk).first()
        if install is None:
            raise NotFoundError("GitHub installation not found for this project")
        repo, _ = Repository.objects.update_or_create(
            project=project,
            external_id=int(external_id),
            defaults={
                "installation": install,
                "full_name": str(full_name)[:300],
                "default_branch": str(default_branch or "main")[:128],
                "private": bool(private),
                "is_active": True,
            },
        )
        return repo

    @staticmethod
    def unlink_repository(project, repo_pk: str) -> None:
        deleted, _ = Repository.objects.filter(project=project, id=repo_pk).delete()
        if not deleted:
            raise NotFoundError("Repository not linked to this project")

    @staticmethod
    def remove_installation(project, install_pk: str) -> None:
        deleted, _ = GitHubInstallation.objects.filter(project=project, id=install_pk).delete()
        if not deleted:
            raise NotFoundError("GitHub installation not found for this project")

    @staticmethod
    def _maybe_mark_revoked(install: GitHubInstallation, exc: Exception) -> None:
        """Lazy revocation: a 401/404 minting or using a token means the
        installation is gone even if we missed the webhook."""
        if isinstance(exc, GitHubApiError) and exc.status_code in (401, 404):
            install.status = GitHubInstallation.Status.REVOKED
            install.save(update_fields=["status", "updated_at"])
            github_client.drop_cached_token(install.installation_id)

    # ── Webhook ─────────────────────────────────────────────────────────

    @staticmethod
    def verify_webhook_signature(raw_body: bytes, signature_header: str) -> bool:
        secret = str(getattr(settings, "GITHUB_WEBHOOK_SECRET", "") or "")
        if not secret:
            return False
        expected = "sha256=" + hmac.new(
            secret.encode("utf-8"), raw_body, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected, signature_header or "")

    @staticmethod
    def handle_webhook(event: str, payload: dict) -> dict:
        """installation + installation_repositories lifecycle. One installation
        may be linked to many projects: handlers match every row."""
        installation_id = int(((payload.get("installation") or {}).get("id")) or 0)
        if not installation_id:
            return {"handled": False}
        installs = GitHubInstallation.objects.filter(installation_id=installation_id)

        if event == "installation":
            action = payload.get("action", "")
            if action == "deleted":
                installs.update(status=GitHubInstallation.Status.REVOKED)
                Repository.objects.filter(
                    installation__installation_id=installation_id
                ).update(is_active=False)
                github_client.drop_cached_token(installation_id)
            elif action == "suspend":
                installs.update(status=GitHubInstallation.Status.SUSPENDED)
                github_client.drop_cached_token(installation_id)
            elif action == "unsuspend":
                installs.update(status=GitHubInstallation.Status.ACTIVE)
            return {"handled": True, "action": action}

        if event == "installation_repositories":
            removed = payload.get("repositories_removed") or []
            removed_ids = [int(r["id"]) for r in removed if r.get("id") is not None]
            if removed_ids:
                Repository.objects.filter(
                    installation__installation_id=installation_id,
                    external_id__in=removed_ids,
                ).update(is_active=False)
            # "added" is a no-op: repos are linked explicitly in the UI.
            return {"handled": True, "removed": len(removed_ids)}

        return {"handled": False}


class CodeMappingService:
    @staticmethod
    def create(app, repository: Repository, stack_trace_root: str, source_root: str,
               branch: str = "") -> CodeMapping:
        root = (stack_trace_root or "").strip()
        if not root:
            raise ValidationError("stack_trace_root is required")
        if repository.project_id != app.project_id:
            raise ValidationError("Repository belongs to a different project")
        mapping, _ = CodeMapping.objects.update_or_create(
            app=app,
            stack_trace_root=root[:300],
            defaults={
                "repository": repository,
                "source_root": (source_root or "").strip().lstrip("/")[:300],
                "branch": (branch or "").strip()[:128],
            },
        )
        return mapping

    @staticmethod
    def delete(app, mapping_pk: str) -> None:
        deleted, _ = CodeMapping.objects.filter(app=app, id=mapping_pk).delete()
        if not deleted:
            raise NotFoundError("Code mapping not found")

    @staticmethod
    def resolve(mappings: list[CodeMapping], runtime_path: str):
        """Longest stack_trace_root prefix wins; None when no mapping matches
        (that's the in-app discriminator — library frames resolve to nothing).
        Windows paths are normalised before matching."""
        path = (runtime_path or "").replace("\\", "/")
        best: CodeMapping | None = None
        for m in mappings:
            root = m.stack_trace_root.replace("\\", "/")
            if path.startswith(root) and (best is None or len(root) > len(best.stack_trace_root)):
                best = m
        if best is None:
            return None
        remainder = path[len(best.stack_trace_root):].lstrip("/")
        source_root = best.source_root.strip("/")
        mapped = f"{source_root}/{remainder}" if source_root else remainder
        return best, mapped


class SuspectCommitService:
    @staticmethod
    def parse_frames(payload: str) -> list[dict]:
        """Traceback frames innermost-LAST (Python order), with line numbers."""
        return [
            {"path": m.group(1), "line": int(m.group(2)), "function": m.group(3)}
            for m in _FRAME_RE.finditer(payload or "")
        ]

    @staticmethod
    def for_event(project, app_id, payload: str, commit_sha: str, event_time) -> dict:
        """Suspect commits + per-frame source links for one error event.

        Algorithm (design doc): innermost frames → code-mapping resolution
        (first ≤3 resolved frames are "in-app") → commits touching those files,
        scoped to the stamped running commit when we have one (deploy-aware),
        else bounded by the event time; ≤1 year; ranked by files-touched then
        recency."""
        result: dict = {"suspect_commits": [], "frame_links": [], "reason": ""}
        if not app_id:
            result["reason"] = "unknown_app"
            return result
        mappings = list(
            CodeMapping.objects.filter(app_id=app_id, repository__is_active=True)
            .select_related("repository", "repository__installation")
        )
        if not mappings:
            result["reason"] = "no_code_mappings"
            return result

        frames = SuspectCommitService.parse_frames(payload)
        if not frames:
            result["reason"] = "no_stack_trace"
            return result

        cache_key = "suspect:" + hashlib.sha1(
            f"{app_id}|{commit_sha}|{payload[:2000]}".encode("utf-8", "replace")
        ).hexdigest()
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        # Resolve frames innermost-first; the first ≤3 that map are in-app.
        in_app: list[dict] = []
        frame_links: list[dict] = []
        for frame in reversed(frames):
            resolved = CodeMappingService.resolve(mappings, frame["path"])
            if resolved is None:
                continue
            mapping, mapped_path = resolved
            repo = mapping.repository
            ref = commit_sha or mapping.branch or repo.default_branch or "main"
            web = github_client.web_base(repo.installation.base_url)
            frame_links.append(
                {
                    "path": frame["path"],
                    "line": frame["line"],
                    "function": frame["function"],
                    "mapped_path": mapped_path,
                    "repository": repo.full_name,
                    "url": f"{web}/{repo.full_name}/blob/{ref}/{mapped_path}#L{frame['line']}",
                }
            )
            if len(in_app) < _SUSPECT_MAX_FRAMES and not any(
                f["mapped_path"] == mapped_path for f in in_app
            ):
                in_app.append(
                    {"mapping": mapping, "mapped_path": mapped_path, "frame": frame}
                )
        if not in_app:
            result["frame_links"] = frame_links
            result["reason"] = "no_in_app_frames"
            return result

        until_iso = ""
        if event_time is not None:
            try:
                until_iso = event_time.astimezone(timezone.utc).isoformat()
            except Exception:
                until_iso = ""

        by_sha: dict[str, dict] = {}
        for entry in in_app:
            repo = entry["mapping"].repository
            install = repo.installation
            try:
                commits = github_client.list_commits_for_path(
                    install.installation_id,
                    repo.full_name,
                    entry["mapped_path"],
                    sha=commit_sha,
                    until=until_iso,
                    per_page=_SUSPECT_MAX_COMMITS,
                    base_url=install.base_url,
                )
            except (GitHubApiError, GitHubNotConfigured) as exc:
                GitHubIntegrationService._maybe_mark_revoked(install, exc)
                logger.warning("suspect-commit lookup failed for %s: %s", repo.full_name, exc)
                result["reason"] = "github_unavailable"
                continue
            for c in commits:
                sha = c.get("sha", "")
                if not sha:
                    continue
                info = by_sha.get(sha)
                commit_data = c.get("commit") or {}
                author = commit_data.get("author") or {}
                if info is None:
                    by_sha[sha] = info = {
                        "sha": sha,
                        "short_sha": sha[:7],
                        "message": str(commit_data.get("message", "")).split("\n", 1)[0][:200],
                        "author_name": str(author.get("name", ""))[:128],
                        "author_login": str((c.get("author") or {}).get("login", ""))[:128],
                        "date": author.get("date", ""),
                        "url": c.get("html_url", ""),
                        "repository": repo.full_name,
                        "files": [],
                    }
                if entry["mapped_path"] not in info["files"]:
                    info["files"].append(entry["mapped_path"])

        cutoff = datetime.now(timezone.utc) - timedelta(days=_SUSPECT_MAX_AGE_DAYS)
        candidates = []
        for info in by_sha.values():
            try:
                commit_date = datetime.fromisoformat(str(info["date"]).replace("Z", "+00:00"))
            except Exception:
                commit_date = None
            if commit_date is not None and commit_date < cutoff:
                continue  # Sentry's 1-year cutoff: older commits aren't suspects
            candidates.append((len(info["files"]), info["date"], info))
        candidates.sort(key=lambda t: (t[0], t[1]), reverse=True)

        result["suspect_commits"] = [c[2] for c in candidates[:_SUSPECT_MAX_COMMITS]]
        result["frame_links"] = frame_links
        cache.set(cache_key, result, _SUSPECT_CACHE_SECONDS)
        return result
