# Phase 1 — Code Link (GitHub integration) design

*Companion to `AI_NATIVE_PLAN.md`. Researched against GitHub App docs and
Sentry's suspect-commit/code-mapping model (fetched 2026-07-15).*

## Goal

Connect APILens projects to source code so that: stack-trace frames link to
the exact file on GitHub, every error issue shows its **suspect commit**, and
Phase 4's fix handoff has a repo to open PRs against. Self-hosted GitHub
(GHES) is a first-class target later — the model carries a `base_url` from
day one (Sentry's documented gap).

## Data model (three levels, deliberately)

```
Project ──< GitHubInstallation     "this project may read these GitHub accounts"
Project ──< Repository             "these repos are linked to this project"
App     ──< CodeMapping ──> Repository   "this app's stack paths live here"
```

- **GitHubInstallation** — one row per (project, GitHub App installation).
  `installation_id`, `account_login/type`, `repository_selection`, `status`
  (active/suspended/revoked), `base_url` ("" = github.com).
- **Repository** — a repo the project explicitly linked. Keyed by GitHub's
  numeric `external_id` (stable across renames), carries `full_name` and
  `default_branch`, `is_active` flips false on access loss.
- **CodeMapping** — **app-level**, not project-level. `stack_trace_root`
  (runtime path prefix, e.g. `/app/`), `source_root` (repo path prefix,
  e.g. `services/checkout/`), optional `branch` override.

### Why app-level mappings — the monorepo/polyrepo matrix

| Topology | Setup |
|---|---|
| **Polyrepo** (each app = its own repo) | Each app gets one CodeMapping to its own Repository. |
| **Monorepo** (all apps in one repo) | All apps map to the *same* Repository with different `source_root`s (`services/checkout/`, `services/identity/`, …). |
| **Hybrid** | Per-app choice; nothing global to fight. |
| **One app, several path roots** (vendored code, src layouts) | Multiple CodeMappings per app; **longest `stack_trace_root` prefix wins** at resolve time. |
| **Same repo in several projects** | Allowed — Repository rows are per-project; uniqueness is (project, external_id). |

Frame resolution: `runtime_path.startswith(stack_trace_root)` → mapped path =
`source_root + runtime_path[len(stack_trace_root):]`. Frames matching no
mapping (site-packages, stdlib) simply don't link — that's the in-app filter.

## Install flow & the spoofed-installation_id problem

GitHub redirects to the app's Setup URL with `?installation_id=…`, and the
docs explicitly warn this **can be spoofed** (an attacker could try to attach
someone else's installation to their own project). Defenses, all implemented:

1. **Signed state**: the install URL carries `state = HMAC(SECRET_KEY,
   project_id|user_id|expiry)`. The complete-installation call must return the
   same state, unexpired, project matching — so only a flow our UI started for
   that exact project can finish, and the finisher must hold a valid session
   for that project (RBAC admin+).
2. **Server-side verification**: on completion we authenticate *as the app*
   and `GET /app/installations/{id}` — the id must exist and belong to OUR
   app; we store the account login GitHub returns, never what the client says.
3. **Residual risk documented**: a determined attacker who can get a victim's
   installation_id could still link it to their own project (GitHub's full fix
   is verifying via a *user* access token — "Request user authorization during
   installation"). Deferred: noted as TODO; the practical exposure is read
   access to commit metadata of repos the victim's installation covers.
   Uninstalling the app (or the webhook) revokes it everywhere instantly.

## Token lifecycle

App JWT (RS256, ≤10 min, `iss` = app id) → `POST
/app/installations/{id}/access_tokens` → installation token, **1 h lifetime**.
We cache tokens in-process per installation and refresh 5 minutes early.
Tokens are never stored in the DB; the app private key comes from settings/env
(`APILENS_GITHUB_APP_PRIVATE_KEY`, PEM) — Secret Manager in prod, never git.

## Revocation & drift (webhook-driven)

Endpoint: `POST /api/v1/integrations/github/webhook` — **unauthenticated but
HMAC-verified** (`X-Hub-Signature-256`, constant-time compare, shared secret
`APILENS_GITHUB_WEBHOOK_SECRET`). Handled events:

| Event | Action |
|---|---|
| `installation` / `deleted` | All matching installations → `revoked`; their repos → `is_active=False`. |
| `installation` / `suspend` · `unsuspend` | Status flip; suspended installs mint no tokens. |
| `installation_repositories` / `removed` | Linked repos in `repositories_removed` → `is_active=False`. |
| `installation_repositories` / `added` | No-op (repos are linked explicitly in the UI; the picker refreshes live). |

Because one installation may be linked to N projects, webhook handlers match
on `installation_id` across all rows, not one project. All other GitHub API
failures (403 token revoked out-of-band, 404 repo gone, rate limit) **fail
soft**: suspect commits/links return empty with a `reason`, never break the
Errors page, and a 401/404 marks the installation revoked lazily.

## Suspect commits (v1 algorithm)

Sentry's model: in-app frames → blame the exact file+line, ≤1 year old.
Our v1 is the files-touched variant, strengthened by Phase 0's deploy data:

1. Take the issue's latest event (stack `payload`, stamped `commit_sha`,
   timestamp) from ClickHouse.
2. Parse traceback frames (same regex as the fingerprinter), innermost first;
   resolve each through the app's CodeMappings; keep the first ≤3 frames that
   resolve (= in-app).
3. Per file: `GET /repos/{repo}/commits?path=<mapped>&sha=<stamped commit or
   default branch>&per_page=5`. Using the **stamped commit as `sha`** scopes
   history to *code that was actually running* — deploy-aware in a way
   time-window heuristics aren't. Fallback when no commit was stamped:
   `until=<event time>` on the default branch.
4. Merge, dedupe by SHA, rank: commits touching more frame-files first, then
   recency; drop >1 year old (Sentry's cutoff); return top 5 with author,
   message, date, html_url + per-frame source links (`blob/<sha>/<path>#L<n>`).
5. Cache per (fingerprint, stamped commit) for 10 min (Django cache).

## Edge cases checklist

- **Monorepo / polyrepo / hybrid** → app-level mappings (matrix above).
- **Spoofed installation_id** → signed state + app-side verification.
- **Uninstall / suspension / repo access revoked** → webhooks above; UI shows
  a "reconnect" banner from `status`.
- **Token expiry** → cached mint-on-demand, 1h tokens, never persisted.
- **Container paths ≠ repo paths** (`/app/…`, `/usr/src/app/…`) →
  `stack_trace_root` strip; suggestions offered from observed stack traces.
- **Windows paths** → normalised (`\` → `/`) before matching.
- **Frames outside any mapping** (libraries) → unmapped ⇒ excluded from
  suspect analysis; that's the in-app discriminator.
- **No stamped commit on old events** → time-window fallback.
- **Repo renamed** → keyed by numeric `external_id`; `full_name` refreshed
  opportunistically.
- **Repo deleted / 404, rate-limited / 403** → fail-soft empty results with
  reason; no page breakage.
- **Multiple installations per project** (e.g. two GitHub orgs) → supported;
  repos carry their installation.
- **Same installation in multiple projects** → supported; webhook updates hit
  every row.
- **GHES** → `base_url` on the installation feeds both web and API URLs
  (deferred UI, model-ready).
- **Permissions creep** → app requests read-only `contents` + `metadata` in
  Phase 1; PR write permissions arrive with Phase 4 (users re-accept —
  `new_permissions_accepted` webhook already handled).

## Out of scope for Phase 1 (deliberate)

GitLab/Bitbucket (provider field kept generic where cheap); automatic
code-mapping derivation beyond prefix suggestions; commit comments/PR
creation (Phase 4); release-diff UI (Phase 2 input).
