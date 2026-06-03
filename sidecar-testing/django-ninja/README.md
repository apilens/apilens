# Django Ninja Sidecar

Run:

```bash
cp .env.example .env
# set APILENS_API_KEY in .env (an app-scoped key; project + app derived server-side)
source .venv/bin/activate
python manage.py migrate
python manage.py runserver 0.0.0.0:${PORT:-8013}
```
