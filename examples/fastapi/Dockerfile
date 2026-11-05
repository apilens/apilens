# APILens example app: FastAPI + the Python SDK from this repo.
# Build context is the repo root (see deploy/compose/compose.examples.yaml).
FROM python:3.14-slim@sha256:0514bc76712d64f8bb48adcb95b1ab0d88c69fee95d62fe4c18ee948bee9b1e1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY examples/fastapi/requirements.txt ./
COPY packages/sdk-python /tmp/sdk-python
RUN pip install -r requirements.txt /tmp/sdk-python && rm -rf /tmp/sdk-python
COPY examples/fastapi/main.py ./

USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
