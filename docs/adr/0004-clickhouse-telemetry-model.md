# 0004 — ClickHouse telemetry model and tenant isolation

**Decision.**
- **Table layout.** Shared tables keyed by `project_id` first in `ORDER BY`, daily partitions with `ttl_only_drop_parts`, ZSTD on heavy columns.
- **Rollups.** Dashboards read `*_1m` / `*_1h` rollups (AggregatingMergeTree via materialized views, t-digest quantiles, split counts for client 4xx and server 5xx).
- **Query path (M3).** Every query goes through one Go query compiler that accepts a typed DSL, injects the tenant predicate, refuses to run without one, and executes read-only with per-tenant limits; raw SQL is banned in CI. This is the PostHog/Langfuse model.
- **Migrations.** Embedded goose files, idempotent DDL.
- **Replication (M3).** Replicated tables + Keeper, applied with `ON CLUSTER`.

**Revisit if** a customer needs physical isolation: offer a per-tenant database as a paid dedicated tier.
