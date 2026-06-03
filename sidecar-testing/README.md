# Sidecar Testing Apps

This folder contains local integration sidecars for testing the APILens Python SDK:

- `fastapi/`
- `flask/`
- `django-ninja/`

Each app sends request telemetry to API Lens through the SDK.

## Common setup

From repo root:

```bash
cd sidecar-testing/<framework>
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set `APILENS_API_KEY` (project-level) and `APILENS_APP_ID` in `.env`, then run the app.
