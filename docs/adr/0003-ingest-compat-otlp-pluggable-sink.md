# 0003 — Ingest: v1 wire compatibility, OTLP, pluggable sink

**Context.** Existing SDKs (apilenss ≤ 0.4, JS, Java) post JSON to `/v1/{requests,logs,traces,deploys}` with `X-API-Key`. Teams already instrumented with OpenTelemetry should not need our SDK. v1 wrote synchronously to ClickHouse with no buffer.

**Decision.**
- The edge keeps the v1 JSON contract byte-for-byte, including normalisation and limits, so SDK users notice nothing.
- It adds OTLP/HTTP at `/otlp/v1/{traces,logs}` (protobuf and JSON), with app selection by resource attribute and partial-success rejection for unknown apps.
- Rows go through a `Sink`. `direct` (M1) group-commits batches with native columnar inserts and returns 503 + Retry-After under backpressure. `kafka` (M3) publishes protobuf batches (`proto/apilens/event/v1`) for writer roles, the same split Grafana Tempo and Mimir 3 use.
- API keys and apps resolve from in-process caches; there are no per-request calls to other services.

**Revisit if** a self-hosted install needs durability across process crashes before Kafka is configured; then add the local disk spool planned for M3.
