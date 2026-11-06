/**
 * Which app the captured data belongs to (mirrors the Python SDK's
 * `apilens.client._app`).
 *
 * `appId` is optional. The client resolves it in this order:
 * 1. `appId` / `app_id` passed in code;
 * 2. env `APILENS_APP_ID`;
 * 3. env `OTEL_SERVICE_NAME`;
 * 4. nothing: records carry an empty `app_id` and the server files them under
 *    the project's default app.
 *
 * Any free-form name works ("Orders API", "orders-api"): the server normalizes
 * it to a slug and creates apps it has not seen, so nothing is validated here.
 */

import type { Env } from "./env.js";
import type { Logger } from "./types.js";

export const ENV_APP_ID = "APILENS_APP_ID";
export const ENV_OTEL_SERVICE_NAME = "OTEL_SERVICE_NAME";
/** Source label for a value passed in code. */
export const APP_SOURCE_CONFIG = "appId";

export type AppIdSource = typeof APP_SOURCE_CONFIG | typeof ENV_APP_ID | typeof ENV_OTEL_SERVICE_NAME | "";

function processEnv(): Env {
  // Guarded so the SDK still loads in runtimes without `process` (edge workers).
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/** `{ appId, source }`; `{ appId: "", source: "" }` when none is configured. */
export function resolveAppId(
  explicit: string | undefined | null,
  env: Env = processEnv(),
): { appId: string; source: AppIdSource } {
  const fromCode = String(explicit ?? "").trim();
  if (fromCode) {
    return { appId: fromCode, source: APP_SOURCE_CONFIG };
  }
  const fromEnv = String(env[ENV_APP_ID] ?? "").trim();
  if (fromEnv) {
    return { appId: fromEnv, source: ENV_APP_ID };
  }
  const otel = String(env[ENV_OTEL_SERVICE_NAME] ?? "").trim();
  if (otel) {
    return { appId: otel, source: ENV_OTEL_SERVICE_NAME };
  }
  return { appId: "", source: "" };
}

/** The startup log line for a resolved app. */
export function describeAppChoice(appId: string, source: AppIdSource): string {
  if (!appId) {
    return "APILens: no app name configured; data goes to the project's default app (set app_id, APILENS_APP_ID or OTEL_SERVICE_NAME)";
  }
  return `APILens: app "${appId}" (from ${source})`;
}

/** Log {@link describeAppChoice} at info level. */
export function logAppChoice(logger: Logger, appId: string, source: AppIdSource): void {
  try {
    logger.info?.(describeAppChoice(appId, source));
  } catch {
    // A broken logger never breaks startup.
  }
}
