# 0008 — Background jobs with River (Go) and DBOS (Python)

**Context.** We need retries, schedules and durable multi-step runs (integration syncs, notifications, AI investigations) without adding a service self-hosters must operate.

**Decision.** River (MPL-2.0, Postgres-backed library) for Go workers. DBOS Transact (MIT library on Postgres) for durable runs in the Python AI service. Both live in processes we already run.

**Rejected.**
- **Hatchet:** its Go SDK pulls a 281-line go.mod into the binary, and its engine had five cross-tenant bugs in 2026.
- **Temporal:** too heavy to ask self-hosters to run.
- **Restate and Inngest:** BSL/SSPL licenses.

**Revisit if** cross-language workflows become central enough to justify a dedicated engine.
