/**
 * APILens shared structured logger.
 *
 * - Production (NODE_ENV=production): JSON to stdout, ready for Cloud Logging.
 * - Local dev: pretty-printed via pino-pretty.
 * - Request correlation: AsyncLocalStorage-backed `requestId` injected into
 *   every log line emitted inside `correlation.run({ requestId }, fn)`.
 *
 * Consumers:
 *
 *   import { createLogger } from "@apilens/logger";
 *   const log = createLogger("ingestion/worker");
 *   log.info({ userId }, "processed event");
 */

import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";

const isProd = process.env.NODE_ENV === "production";

interface LogContext {
  requestId?: string;
  [key: string]: unknown;
}

export const correlation = new AsyncLocalStorage<LogContext>();

const base = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  // pino-pretty is a devDep — only require it when not in prod, so prod
  // bundles don't carry it. Pino just emits JSON natively in prod.
  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
  // Any keys returned here merge into every log line. Lets us inject the
  // request-scoped context (correlation IDs, etc.) without callers wiring it.
  mixin() {
    const ctx = correlation.getStore();
    return ctx ?? {};
  },
});

export function createLogger(name: string): Logger {
  return base.child({ name });
}

/** Re-exports so consumers don't need a separate `pino-http` install. */
export { default as pinoHttp } from "pino-http";
export type { Logger };
