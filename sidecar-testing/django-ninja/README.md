# Django Ninja Sidecar

Run:

```bash
cp .env.example .env
# set APILENS_API_KEY (project-level) and APILENS_APP_ID in .env
source .venv/bin/activate
python manage.py migrate
python manage.py runserver 0.0.0.0:${PORT:-8013}
```
