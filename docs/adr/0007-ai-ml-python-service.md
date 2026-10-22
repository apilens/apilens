# 0007 — AI/ML as a separate Python service with bring-your-own LLM

**Context.** Forecasting and anomaly libraries (statsforecast, Prophet, PyOD) exist essentially only in Python. LLM calls are I/O-bound, so language performance is irrelevant there. Sentry's Seer is a separate Python service; every major competitor keeps its AI closed or cloud-only.

**Decision (M4).**
- **Service shape.** `apps/ai` is a separate service built on FastAPI and Pydantic AI. Self-hosters bring any LLM provider: Anthropic, OpenAI, Google, Bedrock, Ollama or any OpenAI-compatible endpoint. There is no LiteLLM, because of its 2026 supply-chain compromise and KEV-listed CVEs.
- **No database credentials.**
  - The service calls the Go API with user-scoped tokens.
  - It emits typed queries through the same tenant-enforcing compiler as the dashboard.
- **Untrusted telemetry.** A quarantined model with no tools reads telemetry, because request bodies are attacker-controlled.
- **Actions need a human.** Anything with side effects requires human approval.
- **Anomaly detection, two tiers.**
  - Tier 0 runs inside ClickHouse (`seriesDecomposeSTL` + `seriesOutliersDetectTukey`), free for every install.
  - Tier 1 is statsforecast baselines from the Python service.
  - Alert evaluation stays in Go, so a broken ML worker degrades to stale baselines, not broken alerts.
- **MCP.** The MCP server is written in Go; the agent uses the same tools as an MCP client.
