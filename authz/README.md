# authz

SpiceDB schema for APILens ([ADR 0006](../docs/adr/0006-authorization-spicedb.md)).

- `schema.zed` defines `user`, `organization` and `project`.
- `schema.validation.yaml` holds the test fixture and the assertions for every cell of the table below.

Run `task lint:authz` to validate both files with `zed validate`. It is also part of `task lint`.

`schema.go` embeds `schema.zed` into the binary. `apilens migrate` writes it to SpiceDB through the API (idempotent) whenever `authz.endpoint` is set, then runs the reconciler once so every relationship the schema expects exists; `apilens migrate -only=authz` does just that (run the `postgres` step first on an upgrade, the reconciler reads `project_members` and `projects.default_access`). SpiceDB runs in `deploy/compose` (dev and self-host) and optionally in the Helm chart (`spicedb.enabled`).

## Go client

Code checks permissions only through `internal/authz.Client` (`Check`, `CheckBulk`, `LookupResources`, `WriteRelationships`). It fails closed: when SpiceDB cannot answer, the result is a denial with an error wrapping `authz.ErrUnavailable` (answer 503, not 403) and `apilens_authz_errors_total` goes up. ZedTokens from writes are stored per organization in Valkey and reads use `at_least_as_fresh`; allowed results are cached for `authz.cache_ttl` keyed by (subject, permission, resource, zedtoken).

## Roles

| Resource | Relation | Granted by |
| --- | --- | --- |
| `organization` | `owner`, `admin`, `member`, `viewer` | Org membership (one role per user) |
| `project` | `org` | The project's organization |
| `project` | `admin`, `editor`, `viewer` | A direct project role (`project_members`), granted on Access › Members or by an invitation |
| `project` | `default_editor` (subject `organization#member`), `default_viewer` (subjects `organization#member`, `organization#viewer`) | The project's default access ([ADR 0009](../docs/adr/0009-project-access.md)) |

Org owners and org admins are Admin on every project (`org->manage`). Everyone else in the org gets what the project's default access says, written as default relations:

| Default access | Relationships | Org member | Org viewer |
| --- | --- | --- | --- |
| `org_role` (default) | `project:<p>#default_editor@organization:<o>#member`, `project:<p>#default_viewer@organization:<o>#viewer` | Editor | Viewer |
| `viewer` | `project:<p>#default_viewer@organization:<o>#member`, `project:<p>#default_viewer@organization:<o>#viewer` | Viewer | Viewer |
| `none` (restricted) | none | nothing (`view` false) | nothing (`view` false) |

Direct project roles add to that; the highest grant wins. They never grant anything on the org or on other projects. The relay writes the `org_role` relations when a project is created and moves them with the project; a project with no default relations is restricted.

### Project roles at a glance

The target matrix of #753 (D1), which the tables below spell out per
permission:

| Action | Viewer | Editor | Admin |
| --- | :-: | :-: | :-: |
| See data, settings, members, key names and prefixes (`view`) | ✓ | ✓ | ✓ |
| Edit general settings, environments, privacy policy (`edit`) | | ✓ | ✓ |
| Create, rotate and revoke API keys (`manage_keys`) | | ✓ | ✓ |
| Capture policy, alert rules and channels, health checks (`manage_capture`, `manage_alerts`) | | | ✓ |
| Manage access: grant, change role, remove, default access (`manage_access`) | | | ✓ |
| Read the activity log (`view_audit`) | | | ✓ |
| Danger zone: pause, rename slug, delete (`delete`) | | | ✓ |

Org owners and org admins are Admin on every project. Restoring a deleted
project is an organization operation (`organization#manage`), because a
deleted project has no relationships left ([project lifecycle](../docs/architecture/project-lifecycle.md)).

## Role → action mapping

The UI gates on the `Action` vocabulary (`docs/architecture/identity.md`, mirrored in `internal/controlplane/usercontext` (`Vocabulary`) and `apps/ui/src/lib/capabilities.ts`); `GET /api/v1/users/me/context` resolves it per project with one `CheckBulkPermissions` call. Each action resolves to exactly one SpiceDB permission:

| UI action | SpiceDB permission | Org owner | Org admin | Org member | Org viewer | Project admin | Project editor | Project viewer |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `project.read` | `project#view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `project.update` | `project#edit` | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| `project.delete` | `project#delete` | ✓ | ✓ | | | ✓ | | |
| `api_keys.create` | `project#manage_keys` | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| `api_keys.revoke` | `project#manage_keys` | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| `capture.manage` | `project#manage_capture` | ✓ | ✓ | | | ✓ | | |
| `alerts.manage` | `project#manage_alerts` | ✓ | ✓ | | | ✓ | | |
| `access.manage` | `project#manage_access` | ✓ | ✓ | | | ✓ | | |
| `audit.read` | `project#view_audit` | ✓ | ✓ | | | ✓ | | |
| `members.invite` | `organization#invite` | ✓ | ✓ | | | | | |
| `members.remove` | `organization#manage_members` | ✓ | ✓ | | | | | |
| `billing.manage` | `organization#manage_billing` | ✓ | | | | | | |

`project#delete` gates the whole danger zone: deleting the project, pausing and resuming its ingest and renaming its slug.

The org-level permissions are not part of the UI vocabulary. They gate the org screens:

| Permission | Org owner | Org admin | Org member | Org viewer |
| --- | :-: | :-: | :-: | :-: |
| `organization#manage` (org settings, the org audit log, listing and restoring deleted projects) | ✓ | ✓ | | |
| `organization#create_project` | ✓ | ✓ | ✓ | |
| `organization#view` | ✓ | ✓ | ✓ | ✓ |

Project-level permissions outside the UI vocabulary:

| Permission | Org owner | Org admin | Org member | Org viewer | Project admin | Project editor | Project viewer |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `project#manage_capture` (an app's remote capture policy, `PUT /api/v1/apps/{id}/capture-policy`; renaming, archiving, restoring, merging, deleting and acknowledging apps, `/api/v1/projects/{slug}/apps/{id}/...`) | ✓ | ✓ | | | ✓ | | |
| `project#manage_alerts` (alert rules and notification channels, `POST/PUT/DELETE /api/v1/projects/{project}/alerts/...`) | ✓ | ✓ | | | ✓ | | |
| `project#manage_access` (grant, change and remove project roles, change the default access) | ✓ | ✓ | | | ✓ | | |
| `project#view_audit` (read the project's activity log) | ✓ | ✓ | | | ✓ | | |

The two tables above assume the default access `org_role`. With `viewer`, the org member column reads like the org viewer column (only `project#view`). With `none`, org members and org viewers have no project permission at all unless they hold a direct role. Org owner, org admin and the direct project roles do not depend on the default. `schema.validation.yaml` asserts every cell for all three defaults (projects `web`, `docs`, `vault`).

## Enforcement in the API

Typed API operations on one organization or project declare their permission with an `authz.Guard` middleware (`internal/authz/require.go`): `guard.RequireOrg(api, authz.OrgManage)` or `guard.RequireProject(api, authz.ProjectEdit)`. The guard reads the resource from the path (`{org}`, else `{slug}`, for the organization; `{project}`, else `{slug}` under `{org}`, for the project), resolves the slug to an id through a short-lived cache, and asks SpiceDB. The answers are stable:

| Situation | Answer |
| --- | --- |
| No active organization/project with that slug | 404 `not_found` |
| The caller cannot `view` it | 404 `not_found` (identical body, so existence never leaks) |
| The caller can view it but lacks the permission | 403 `forbidden` |
| SpiceDB cannot answer | 503 `authz_unavailable` with `Retry-After` (fail closed) |

API keys only ever satisfy `project#view` on their own project; OAuth clients hold no grants. Handlers read the resolved ids with `authz.TargetFromContext`.

Operations under `/api/v1/projects/{slug}` (no `{org}` in the path) check in the handler with `guard.AuthorizeProject`, which gives the same answers, and pass the resolved project id to the service; services never check roles themselves (#770). Projects, environments and the privacy policy: `view` to read, `edit` to change, `delete` to delete, pause, resume and rename the slug. API keys: `view` to list, `manage_keys` to create, change, rotate and revoke. Project access: `view` to list who has access, `manage_access` to grant, change and remove roles and to set the default access. Audit events: `view_audit` on the project, `organization#manage` for the org log. `GET /api/v1/orgs/{slug}/projects` needs `organization#view` and lists only the projects the caller can `view`; the `role` of a project in the API is the caller's effective project role (`admin` ⇔ `manage_access`, `editor` ⇔ `edit`, `viewer` ⇔ `view`, answered by one `CheckBulk`).

## Changing the schema

1. Edit `schema.zed`.
2. Update the table above and the assertions in `schema.validation.yaml` in the same change.
3. Run `task lint:authz`.

## Upgrade order (default access, #768)

Projects created before the default relations existed have only `project#org`, and under the old schema org members and org viewers reached them through the organization (`org->create_project`, `org->view`). Writing the new schema before their `org_role` relations exist would lock those people out, so `apilens migrate` upgrades in this order and keeps the old terms until the backfill has run:

1. **Postgres.** Migration 00032 adds `project_members` and `projects.default_access` (`org_role` for every existing project, which is today's access).
2. **Bridge schema.** When the schema SpiceDB holds still lets org access flow down to projects (`authz.InheritsOrgAccess`), migrate writes `authz.BridgeSchema()`: `schema.zed` with the new relations and the old `+ org->create_project` (on `manage_keys`, `edit`) and `+ org->view` (on `view`) terms kept. It grants exactly what the old schema did, because no project is restricted yet.
3. **Backfill.** The reconciler writes the default relations from `projects.default_access` and the direct roles from `project_members` (and repairs any other drift).
4. **Final schema.** Migrate writes `schema.zed`; from now on org members and org viewers reach a project only through its default relations.

A failure between steps leaves the bridge in place, which is safe; running `apilens migrate` again resumes at step 2. A fresh install or a SpiceDB already on the final schema skips the bridge (schema, then reconcile). `TestMigrateUpgradeKeepsAccess` (`internal/app`) checks every permission of every org member before, during and after the upgrade. Delete `BridgeSchema` once no supported release predates the default relations.

## Reconciler

The hourly reconciler (and `apilens authz reconcile`) owns every relationship the relay writes: org roles, `project#org`, the direct project roles `project#{admin,editor,viewer}` (from `project_members`) and the default relations (from `projects.default_access`). It restores what is missing and deletes any of these that Postgres has no row for, for example a project role granted by hand in SpiceDB.

The schema is append-friendly: SpiceDB rejects a schema write that removes a relation still in use, so rename or remove a relation in two steps (stop writing it, then delete it).
