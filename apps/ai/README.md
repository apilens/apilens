# apilens-ai

The APILens AI/ML service (Python 3.14, FastAPI). In Milestone 1 it only
exposes `/livez` and `/readyz`; agents, anomaly baselines and forecasting
arrive in M4.

```sh
# from the repo root (uv workspace)
uv sync --all-packages
cd apps/ai
uv run uvicorn apilens_ai.main:app --reload --port 8000
uv run ruff check && uv run ruff format --check && uv run pyright && uv run pytest
```

Configuration comes from `APILENS_AI_*` environment variables
(`APILENS_AI_API_BASE_URL`, `APILENS_AI_LOG_LEVEL`).
