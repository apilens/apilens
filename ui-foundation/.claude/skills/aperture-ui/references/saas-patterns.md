# Multi-tenant SaaS patterns

Researched October 2026 from product docs and design systems (Vercel, Linear,
GitHub, Stripe, Sentry, Datadog, Clerk, WorkOS, Primer, Carbon, Atlassian,
Polaris). Where sources conflict, the reconciled rule is stated.

## Tenant context

- The tenant is in the path: `/projects/[slug]/<section>`. The server checks membership on every request; the URL is the source of truth.
- The switcher sits top-left, always shows the active project's mark (`TenantAvatar`) and name, plus the org. It lists projects with the user's role, marks the current one, and offers "Create project".
- **Switching keeps the section** (Traffic → Traffic) but drops resource ids that may not exist in the other project. It never shows the old tenant's data under the new tenant's name.
- Persist the last-used project (cookie) only to skip the picker from `/`.
- Deep link to a project you're not a member of → **404** (don't confirm it exists). Member without permission → **403** page that names the required role and offers "Request access".
- Environment is always visible (`EnvBadge`). Production is labeled most clearly. Outside production, say so.
- ⌘K search spans projects, pages, endpoints and settings, and shows the current scope.

## Permission-aware UI

- **One contract.** The backend returns the caller's allowed actions (with a reason) for the active project alongside the page data. Components ask `useCan(action)`. Check permissions, never role names.
- **Disable vs hide vs read-only** (Carbon says hide; Primer and Smashing say disable with an explanation; reconciled):
  - The user would expect the action to exist, or could get access → **disable + reason** (`<Gated>`): "Only admins can create API keys. Ask an admin for access."
  - Admin-only surfaces that are noise to everyone else → **hide** (`mode="hide"`).
  - Forms a viewer may see but not change → **read-only** fields (`Field editableBy`), still focusable and announced.
- Default-deny while capabilities load: render a skeleton, never "show, then remove".
- UI gating is UX. Every server action and route handler re-checks. Don't rely on layouts for security (they don't re-render on navigation).
- A view-only role gets a `Banner` explaining why controls are disabled.

## Members and roles

- Invite several emails at once with a role per invite; pending invites listed separately with expiry; role editable in place.
- Every role in a picker has a one-line description of what it can do.
- Block removing or demoting the last owner ("Promote another owner first"). Users can leave a project from the same row menu.

## Settings

- Split: personal (account) · project · organization/administration. Never mix personal preferences into project settings.
- Explicit save for forms, autosave for toggles, never both in one panel. One save button per panel, enabled; confirm success inline.
- Danger zone last, bordered in danger, one row per action with its consequence in plain words. Confirm by typing the slug. Buttons name the outcome ("Delete project" / "Cancel"), never Yes/No. Prefer scheduled, cancellable deletion and say the restore window.

## API keys

- Show the secret **once**, at creation, with copy and a reminder to store it.
- Lists show name, an identifiable prefix (`apl_live_…`) plus masked rest, environment, created, last used ("Never used" is a state worth showing), and Revoke (`destructive-ghost`, gated).
- Rotation offers a grace period during which the old key keeps working.

## Audit log

- Event = `resource.verb`, actor, target, context (IP/location, user agent), time, scoped to the tenant.
- Filter by actor, action and date; export CSV/JSON. Staff/support access appears in the customer's audit log.

## System banners

- **One banner slot**, above the top bar, in priority order: support access/impersonation → read-only or maintenance → degraded ingestion → usage limits/dropped data → trial.
- Critical and impersonation banners can't be dismissed while the state is true. Not for marketing.
- In degraded or read-only mode keep navigation and reads working. Blocked writes get a clear inline error.

## Usage and limits

- Say exactly what happens at the limit. For an observability product: "Requests over your plan limit are dropped and can't be recovered."
- Threshold alerts at about 80% and 100%. Meters turn warning at 75% and danger at 90%, with exact values on hover.
- Upgrade prompts: one per page at most, only where the limit or feature is relevant.

## Observability scope

- One global time range per page; relative vs fixed is explicit; timezone shown (UTC toggle); live has Pause.
- Scope in the URL (`env`, `range` or `from`/`to`, `tz`, `live`), persisted across sections.
