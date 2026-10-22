# 0001 — One Go binary with role targets

**Context.** v1 split Django into identity/core containers that shared one database, and hand-copied ingest logic into a separate FastAPI service; the copy drifted (different payload limits). v2 must scale horizontally, and self-hosters need a small footprint.

**Decision.** One Go module produces one binary. `-target` selects roles (`edge`, `writer`, `query`, `api`, `identity`, … or `all`), wired by a small lifecycle manager (`internal/platform/modules`, dskit semantics without the dependency). Services are split by **workload profile** (ingest edge, stream writers, query, control plane, workers), not by business domain. Go over Rust: implementation quality dominated the published benchmarks (a Go collector beat every Rust one in VictoriaMetrics' 2026 test), clickhouse-go is the only mature native-protocol client, Grafana Mimir proves Go at a billion active series, and the auth/authz/MCP libraries we need are Go-first. A single binary requires a single language.

**Revisit if** profiling shows edge CPU per event as a top cost or GC pauses in p99; then rewrite only that role in Rust behind the same protobuf/Kafka contract.
