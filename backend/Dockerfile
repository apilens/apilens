FROM python:3.13-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libjpeg-dev \
    libpng-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

COPY pyproject.toml ./
RUN uv venv /opt/venv && \
    . /opt/venv/bin/activate && \
    uv pip install --no-cache . whitenoise[brotli]


FROM python:3.13-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo \
    libpng16-16 \
    && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    DJANGO_SETTINGS_MODULE=config.settings

COPY --from=builder /opt/venv /opt/venv

COPY . .

RUN DJANGO_SECRET_KEY=build-placeholder-collectstatic \
    DJANGO_DEBUG=False \
    python manage.py collectstatic --noinput

RUN chmod +x scripts/start.sh

EXPOSE 8000

# Useful when running locally via `docker run` / docker compose — Cloud Run
# ignores Dockerfile HEALTHCHECK in favour of the service-level probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request,sys,os; urllib.request.urlopen(f'http://localhost:{os.environ.get(\"PORT\",\"8000\")}/api/v1/health', timeout=3).read()" || exit 1

CMD ["scripts/start.sh"]
