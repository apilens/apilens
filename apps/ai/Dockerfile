# syntax=docker/dockerfile:1
#
# APILens AI/ML service image.
#
# BUILD CONTEXT IS THE REPO ROOT: the uv workspace root (pyproject.toml +
# uv.lock) lives there.
#   docker build -f apps/ai/Dockerfile -t ghcr.io/apilens/ai:dev .

# Pinned by digest; Renovate bumps both tag and digest.
FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv

FROM python:3.14-slim@sha256:0514bc76712d64f8bb48adcb95b1ab0d88c69fee95d62fe4c18ee948bee9b1e1 AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src

# Dependencies first (cached unless the lockfile changes).
COPY pyproject.toml uv.lock ./
COPY apps/ai/pyproject.toml apps/ai/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package apilens-ai --no-install-workspace

# Then the service itself, installed non-editable so the venv is self-contained.
COPY apps/ai apps/ai
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package apilens-ai --no-editable

FROM python:3.14-slim@sha256:0514bc76712d64f8bb48adcb95b1ab0d88c69fee95d62fe4c18ee948bee9b1e1 AS runtime
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY --from=build --chown=65532:65532 /app/.venv /app/.venv
WORKDIR /app
USER 65532:65532
EXPOSE 8000
CMD ["uvicorn", "apilens_ai.main:app", "--host", "0.0.0.0", "--port", "8000"]
