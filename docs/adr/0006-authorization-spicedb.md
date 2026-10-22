# 0006 — Authorization with SpiceDB and a transactional outbox

**Context.** Five consumers (api, query, AI service, MCP, workers) need the same permission data: org → team → project → environment roles, per-resource sharing, and agent delegation.

**Decision (M2).**
- **Engine.** SpiceDB (Apache-2.0) on Postgres. Distributed check caching improves with cluster size, ZedTokens prevent the new-enemy problem, and the Go and Python SDKs are 1.x.
- **Source of truth and sync.**
  - Postgres stays the source of truth.
  - Writes go to the outbox in the same transaction.
  - An ordered relay applies them with idempotent TOUCH/DELETE.
  - An hourly reconciler repairs drift.
- **List pages.** LookupResources for projects, whose result becomes the ClickHouse allow-list. SQL candidates plus CheckBulkPermissions for dashboards and alerts.
- **Agents.** Agents act with RFC 8693 tokens (`sub` = user, `act` = agent) and only `view_*` permissions.
- **OPA.** Removed; v1 failed open when OPA was unreachable, and v2 fails closed.

**Revisit if** vendor-neutral governance outweighs scaling, in which case use OpenFGA (CNCF incubating); or if we go multi-region, which needs a multi-region datastore (CockroachDB is no longer open source).
