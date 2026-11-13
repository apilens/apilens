# 0009 — Project access model: roles, default access, effective role

**Context.** ADR 0006 names project roles and per-project sharing but does not design them. `authz/schema.zed` already declares `project#admin`, `project#editor` and `project#viewer`, yet nothing writes them: there is no table, no outbox topic, no API and no UI, and every project is open to the whole organization. M4 adds the Access page, so we need one model for who can do what on a project, how an org restricts a project, and how the UI explains a person's access. The decisions below are fixed in issue #753 (D1 to D5).

**Decision (M4).**
- **Three project roles: Admin, Editor, Viewer.** They map one to one onto the existing SpiceDB relations. Org owners and org admins are Admin on every project and cannot be lowered on a single project.
- **Default access per project.** Each project has a `default_access` setting that decides what org members get without a direct grant:
  - `org_role` (the default, today's behaviour): an org member is Editor, an org viewer is Viewer.
  - `viewer`: every org member and org viewer is Viewer.
  - `none` (restricted): only org owners, org admins and people added directly can see the project.
- **Highest grant wins.** A person's effective role is the highest of their org-derived role (owner/admin → Admin), the project default and any direct grant. A direct grant can raise access above the default but never lower it below the org-derived role. The Members tab shows the effective role and its source: organization role, project default, or added directly.
- **Grants only to org members.** A direct project grant is for an existing org member. Inviting a new email from the Access page creates an org invitation that carries the project role; the grant is applied when the invitation is accepted. Removing someone from the org removes their project grants.
- **No teams or groups yet.** Grants are per user. Teams are deferred (#754).
- **Storage and sync** follow ADR 0006: Postgres holds grants and `default_access`, writes go through the outbox in the same transaction, the relay writes the SpiceDB relationships, the reconciler repairs drift. The SpiceDB assertions in `authz/schema.validation.yaml` are the source of truth for the matrix below.

**Role matrix.**

| Action | Viewer | Editor | Admin |
|---|---|---|---|
| See data, settings, members, key names and prefixes | yes | yes | yes |
| Edit general settings, environments, privacy policy | no | yes | yes |
| Create, rotate and revoke API keys | no | yes | yes |
| Capture policy, alert rules and channels, health checks | no | no | yes |
| Manage access (grant, change role, remove, default access) | no | no | yes |
| Read the activity log | no | no | yes |
| Danger zone (pause, rename slug, delete, restore) | no | no | yes |

Org owner and org admin are Admin on every project. With default access `org_role`, an org member is Editor and an org viewer is Viewer.

**Consequences.**
- Existing projects keep their behaviour: `org_role` is the default, so no one gains or loses access when this ships.
- `none` makes a project invisible to ordinary org members: the guard in `internal/authz/require.go` returns 404, list pages drop it through LookupResources, and the ClickHouse allow-list excludes it.
- Handlers that still check the org membership role must move to SpiceDB permissions, or a restricted project leaks.
- Effective role is computed, not stored, so changing an org role or the project default takes effect without rewriting grants.
- Three roles cover the matrix; finer control (custom roles, teams) needs a new ADR.

**Rejected.**
- **Sentry-style mandatory teams** (projects are reachable only through teams): adds a second object to manage before a small org can share one project, and Vercel and PostHog gate groups to Enterprise. Deferred, not ruled out (#754).
- **GitHub's five repository roles** (read, triage, write, maintain, admin): triage and maintain have no counterpart in an observability product; five roles make the Members tab harder to read without unlocking any action in the matrix.
- **Lowest grant wins / deny grants**: lets a direct grant take access away from an org admin, which breaks "org admins can always fix access" and makes the effective role hard to explain.

**Based on.**
- Vercel: [project-level roles](https://vercel.com/docs/rbac/access-roles/project-level-roles), [access roles](https://vercel.com/docs/rbac/access-roles), [access groups](https://vercel.com/docs/rbac/access-groups).
- PostHog: [access control](https://posthog.com/docs/settings/access-control) (per-project default, private projects, highest level from any source).
- Grafana: [roles and permissions](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/) (View / Edit / Admin).
- Rejected alternatives: [Sentry membership and teams](https://docs.sentry.io/organization/membership/), [GitHub repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization).

**Revisit if** customers need groups of people across many projects (teams, #754), custom roles, or a role between Editor and Admin.
