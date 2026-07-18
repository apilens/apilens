# APILens MCP server — build from the REPO ROOT:
#   docker build -f apps/mcp/Dockerfile -t apilens-mcp .
# Serves streamable-HTTP MCP on :8300 (prod: mcp.apilens.ai via Caddy).
# Shares apps/api's code + settings (Django bootstrapped in-process), so it
# needs the same APILENS_* / DATABASE_URL / CLICKHOUSE env as the api service.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /srv

COPY apps/api /srv/api
COPY apps/mcp /srv/mcp

RUN pip install --no-cache-dir uv \
    && uv pip install --system -r /srv/api/pyproject.toml \
    && uv pip install --system "mcp>=1.10" uvicorn

ENV PORT=8300
EXPOSE 8300

WORKDIR /srv/api
CMD ["python", "/srv/mcp/server.py"]
