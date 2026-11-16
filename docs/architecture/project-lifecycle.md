# Project lifecycle

How a project is paused, renamed, deleted, restored and purged (M4, decisions
D8, D9 and D12 in #753). The API lives in
`internal/controlplane/api/projects.go`, the service in
`internal/controlplane/projects` (`pause.go`, `lifecycle.go`) and the purge
job in `internal/controlplane/purge`. Who may do what is in
[`authz/README.md`](../../authz/README.md); the audit kinds are listed in
[`overview.md`](overview.md#audit-events-m2).

```
            pause ┌────────┐
   active ───────►│ paused │  ingest answers 403 project_paused; data, dashboard
     ▲ ▲ ◄─────── └────────┘  and query API unchanged
     │ │  resume
     │ │
     │ └──────── restore (before purge_after; org owners and admins)
     │      │
   rename   │  delete             purge_after passed
   slug     └──── deleted ──────────────────────────► purged (tombstone)
                  (purge_after = now + 7 days)        data gone, slug reserved 30 days
```

## States

| State | Postgres (`projects`) | Who sees it | Ingest |
|---|---|---|---|
| active | `deleted_at` NULL, `paused_at` NULL | everyone with `project#view` | accepted |
| paused | `paused_at`, `paused_by` set | as active | 403 `project_paused` |
| deleted | `deleted_at`, `purge_after` set | org owners and admins, in the deleted projects list only | 403 `project_deleted` |
| purged | `deleted_at` set, `purge_after` NULL, `project_purges.step = done` | nobody (tombstone row: id, org, slug, name) | refused: 401 `authentication_error` once the purge deleted its keys |

## Operations

| Operation | Endpoint | Permission | Recent sign-in | Audit event | Email to project admins |
|---|---|---|:-:|---|:-:|
| Pause ingest | `POST /api/v1/projects/{slug}/pause` | `project#delete` | | `project.paused` | yes |
| Resume ingest | `POST /api/v1/projects/{slug}/resume` | `project#delete` | | `project.resumed` | yes |
| Rename the slug | `POST /api/v1/projects/{slug}/rename` | `project#delete` | yes | `project.slug_changed` | |
| Delete | `DELETE /api/v1/projects/{slug}` (`confirm` = the slug) | `project#delete` | yes | `project.deleted` | yes, always |
| List deleted projects | `GET /api/v1/orgs/{slug}/projects/deleted` | `organization#manage` | | | |
| Restore | `POST /api/v1/orgs/{slug}/projects/{id}/restore` | `organization#manage` | yes | `project.restored` | yes |
| Purge (job) | hourly `controlplane.purge_deleted_projects`; `apilens project purge <id>` | system | | `project.purged` | |

`project#delete` is the project Admin's danger-zone permission (project
admins, org owners and org admins). "Recent sign-in" is
`authz.RequireRecentAuth`: the access token's `auth_time` must be less than
`identity.sensitive_action_max_age` (10 minutes) old, else `reauth_required`
(see [`identity.md`](identity.md#sensitive-operations-recent-sign-in)).
Project admins can turn the change emails off with
`preferences.security_emails`; the deletion email is always sent.

## Pause and resume

Pausing sets `paused_at` (migration 00041). The ingest edge reads it with the
API key, so every ingest call made with one of the project's keys answers 403
`project_paused` and counts in `apilens_ingest_rejected_total`; SDKs drop
those batches without retrying. The project's key hashes are dropped from
every ingest key cache after the commit, so the change applies at once with
Valkey and within `ingest.key_cache_ttl` without it. Stored data, the
dashboard and the query API are unaffected. Pausing a paused project, or
resuming an active one, changes nothing.

## Rename the slug and slug history

The slug can change; the project id never does, so telemetry, keys and SDK
setups are untouched (no data moves). A rename writes the old slug to
`project_slug_history` (migration 00043, one row per slug, pointing at the
project that used it last):

- Path resolution falls back to the history when no active project uses a
  slug, so the old slug keeps leading to the project. Responses carry the
  current slug in `Content-Location` and, on project bodies, `canonical_slug`.
- For 30 days after `retired_at` only that project may take the slug back;
  creating or renaming another project to it answers `slug_taken` (409, with
  up to three `suggestions`) and `GET /api/v1/projects/slug-available`
  reports it taken. After that it is free; the row keeps resolving until a
  project uses the slug, which deletes the row.
- Renaming to the current slug changes nothing.

## Delete

`DELETE /api/v1/projects/{slug}` with `confirm` equal to the slug
(`confirmation_mismatch` otherwise) removes nothing. In one transaction it
sets `deleted_at` and `purge_after = now + project.deletion_grace` (7 days by
default, migration 00042), emits the `project.deleted` outbox topic, records
`project.deleted` with the purge date and emails the project admins. From that
moment:

- every project endpoint answers 404 and the project leaves the
  organization's project list and the user context;
- the relay deletes every SpiceDB relationship of the project, so nobody,
  org owners and admins included, holds a project permission. Postgres keeps
  `projects.default_access` and the `project_members` rows for a restore;
- its API keys are dropped from every ingest key cache and ingest answers 403
  `project_deleted`;
- its slug stays reserved (`projects_slug_reserved` covers active projects and
  projects awaiting purge), so a restore never collides with a newer project.

`project.deletion_grace` set to `0` makes the purge due at once (no restore
window).

## Restore

Before `purge_after`, an org owner or admin restores the project from the
deleted projects list. In one transaction restore clears `deleted_at` and
`purge_after`, emits `project.restored` (the default access and every direct
grant read from Postgres, so the relay writes the relationships back exactly
as they were), records `project.restored` and emails the project admins; then
the keys are dropped from the ingest caches so they work again at once.
Access, API keys, apps, environments and the slug come back as before. A
project past `purge_after`, not deleted or of another organization answers
404.

## Purge

The hourly River job `controlplane.purge_deleted_projects` (`purge.Interval`,
up to 100 projects a run, 30 minutes per run) purges projects whose
`purge_after` has passed, projects deleted before `purge_after` existed, and
the projects of an organization deleted more than the same grace ago (an
organization delete cannot be undone). `apilens project purge <project id>`
runs it for one deleted project now, also inside its grace period.

`project_purges` (migration 00044) records the next step per project, so a
run that is killed resumes where it stopped; every step is idempotent:

1. **clickhouse**: delete the project's rows from every telemetry table (a
   mutation, waited for).
2. **valkey**: delete every `apilens:*` key naming the project, one of its
   apps or one of its API keys (usage, quota, stats, last seen).
3. **files**: remove the stored files of its request exports.
4. **postgres**, one transaction: hard-delete apps, environments, keys,
   policies, alert rules and channels, health checks, uptime monitors, saved
   views, exports, direct grants and invitation grants; emit `project.deleted`
   again (the relay drops any SpiceDB relationship left); move the slug to
   the 30-day reservation in `project_slug_history`; clear `purge_after`;
   record `project.purged` (org-scoped, no actor); mark the purge `done`.

The `projects` row stays as a tombstone (id, org, slug, name) so audit events
and the slug reservation keep pointing at something. The project's audit
events are kept: they carry `project_id` and the target label, and follow the
audit retention (`audit.retention`, 400 days by default) like every other
event.
