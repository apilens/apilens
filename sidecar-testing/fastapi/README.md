# FastAPI Sidecar

Run:

```bash
cp .env.example .env
# set APILENS_API_KEY in .env (an app-scoped key; project + app derived server-side)
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8011} --reload
```

Quick check:

```bash
curl -i http://127.0.0.1:${PORT:-8011}/health
```
