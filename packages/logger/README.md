# @apilens/logger

Shared structured logger for APILens TS/JS apps. Pino-backed.

- Local dev: pretty-printed (via `pino-pretty`).
- Production (`NODE_ENV=production`): JSON to stdout, picked up natively by Cloud Logging.

## Use it

```ts
import { createLogger } from "@apilens/logger";

const log = createLogger("ingestion/worker");
log.info({ userId, eventId }, "processed event");
```

## Request correlation

Wrap your request handler so every log line emitted while handling it carries the same `requestId`:

```ts
import { correlation } from "@apilens/logger";
import { randomUUID } from "node:crypto";

app.use((req, _res, next) => {
  correlation.run({ requestId: req.headers["x-request-id"] ?? randomUUID() }, next);
});
```

After that any `log.info(...)` inside the request will include `"requestId": "..."` automatically.

## Express / Fastify HTTP logger

Re-exported `pino-http` so you don't need a second install:

```ts
import express from "express";
import { pinoHttp, createLogger } from "@apilens/logger";

const app = express();
app.use(pinoHttp({ logger: createLogger("web/http") }));
```

## Why not Python?

This package is JS/TS only — the Django API has its own `logging.dictConfig`. If we need shared log shape across both runtimes, a companion `@apilens/logger-py` (structlog-based) belongs alongside this — not added until there's a concrete need.
