# FastAPI Sidecar

Run:

```bash
cp .env.example .env
# set APILENS_API_KEY, APILENS_PROJECT_SLUG, and APILENS_APP_ID in .env
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8011} --reload
```

Quick check:

```bash
curl -i http://127.0.0.1:${PORT:-8011}/health
```
