# Architecture decision records

Short records of decisions that shape v2. Each one states the context, the
decision, and what would make us revisit it. New ADRs are proposed in a PR
(see GOVERNANCE.md) and numbered sequentially.

| # | Decision | Status |
|---|---|---|
| [0001](0001-single-binary-role-targets.md) | One Go binary with role targets; split by workload, not by feature | Accepted |
| [0002](0002-open-source-only.md) | Open-source, self-hostable dependencies only | Accepted |
| [0003](0003-ingest-compat-otlp-pluggable-sink.md) | Ingest: v1 wire compatibility, OTLP, pluggable sink | Accepted |
| [0004](0004-clickhouse-telemetry-model.md) | ClickHouse telemetry model and tenant isolation | Accepted |
| [0005](0005-identity-built-in.md) | Identity built into the Go codebase, deployed as its own role | Accepted (M2) |
| [0006](0006-authorization-spicedb.md) | Authorization with SpiceDB and a transactional outbox | Accepted (M2) |
| [0007](0007-ai-ml-python-service.md) | AI/ML as a separate Python service with bring-your-own LLM | Accepted (M4) |
| [0008](0008-background-jobs.md) | Background jobs with River (Go) and DBOS (Python) | Accepted (M2–M4) |
