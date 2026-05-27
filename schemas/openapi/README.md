# OpenAPI schema

`openapi.yaml` is the source-of-truth API contract used to generate SDK clients.

## How it's generated

The backend (`apps/api`) is a Django + Django Ninja service. Ninja emits a live OpenAPI 3.1 doc at `/api/v1/openapi.json`. This YAML is a snapshot of that endpoint, committed so SDK generation is deterministic without needing a running backend.

## Regenerate

```bash
pnpm sdks:generate
```

That runs `scripts/release/gen-sdks.sh`, which:

1. Curls `${API_URL}/api/v1/openapi.json` (default: `http://localhost:8000`; override with `API_URL=https://api.apilens.ai`).
2. Converts JSON → YAML and writes here.
3. Generates client code into `packages/sdk-typescript/src/generated/` (TS) and other SDK package generators as they're added.

## When to refresh

After any **breaking** API contract change. Non-breaking additions (new field, new endpoint) can wait for the next release cut.
