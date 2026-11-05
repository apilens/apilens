/**
 * App metadata report: `POST /v1/metadata` once per process start
 * (contract: the `AppMetadata` schema of api/openapi/apilens.v1.json).
 *
 * ```json
 * {
 *   "app_id": "orders-api",
 *   "project_slug": "shop",          // only when configured
 *   "environment": "production",
 *   "framework": "express",
 *   "framework_version": "5.1.0",
 *   "node_version": "22.11.0",
 *   "sdk_version": "0.1.0",
 *   "routes": [{ "method": "GET", "path": "/orders/{id}" }],  // at most 2000
 *   "config": { "capture_headers": true, "sample_rate": 1, ... }
 * }
 * ```
 *
 * `config` is the effective configuration: built-in redaction patterns and
 * exclusions are included, callbacks are reported as booleans only. Never
 * sent: the API key (any key naming one is stripped at any depth before the
 * POST), the fetch implementation or the logger.
 */

import { METHODS } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

import { SDK_VERSION, type ApiLensClient } from "./client.js";
import type { RequestExcluder } from "./exclusions.js";
import { expressPathToTemplate } from "./routes.js";
import type { Redactor } from "./sanitize.js";

/** Route templates past this many are not reported (ingest keeps as many). */
export const MAX_METADATA_ROUTES = 2000;

export type AppRoute = { method: string; path: string };

type ExpressLayer = {
  name?: string;
  handle?: { stack?: unknown };
  route?: { path?: unknown; methods?: Record<string, boolean> };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: ReadonlyArray<{ name?: string | number }>;
  slash?: boolean;
};

/** The root router of an Express 4 (`app._router`) or 5 (`app.router`) app. */
function rootStack(app: unknown): unknown[] | undefined {
  if (!app || (typeof app !== "object" && typeof app !== "function")) {
    return undefined;
  }
  const candidate = app as { _router?: { stack?: unknown }; router?: { stack?: unknown } };
  let router: { stack?: unknown } | undefined = candidate._router;
  if (!router) {
    try {
      // Express 4 defines `app.router` as a getter that throws.
      router = candidate.router;
    } catch {
      router = undefined;
    }
  }
  return Array.isArray(router?.stack) ? router.stack : undefined;
}

// Express 4 compiles `/users/:id` to `^\/users\/(?:([^\/]+?))\/?(?=\/|$)`.
const PARAM_GROUP = /\(\?:\(\[\^\\\/\]\+\?\)\)/g;
const MOUNT_SUFFIX = /\\\/\?\(\?=\\\/\|\$\)$/;

/**
 * The path a router layer is mounted at: "" for the root, undefined when it
 * cannot be recovered (Express 5 keeps only a matcher closure for a non-root
 * mount; a RegExp mount path has no template).
 */
function mountPath(layer: ExpressLayer): string | undefined {
  if (layer.slash || layer.regexp?.fast_slash) {
    return "";
  }
  if (!(layer.regexp instanceof RegExp)) {
    return undefined;
  }
  let index = 0;
  const keys = layer.keys ?? [];
  const source = layer.regexp.source.replace(PARAM_GROUP, () => {
    const name = keys[index]?.name ?? index;
    index += 1;
    return `:${String(name)}`;
  });
  if (!source.startsWith("^") || !MOUNT_SUFFIX.test(source)) {
    return undefined;
  }
  const body = source.slice(1).replace(MOUNT_SUFFIX, "");
  // Anything still special to a regex means a pattern, not a template.
  if (/(^|[^\\])[.*+?^${}()|[\]]/.test(body)) {
    return undefined;
  }
  return body.replace(/\\(.)/g, "$1");
}

function joinPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

function routePaths(path: unknown): string[] {
  if (typeof path === "string") {
    return [path];
  }
  if (Array.isArray(path)) {
    return path.filter((p): p is string => typeof p === "string");
  }
  return []; // a RegExp route has no template
}

function walk(stack: unknown[], prefix: string, out: AppRoute[], seen: Set<string>, depth: number): void {
  if (depth > 32) {
    return;
  }
  for (const item of stack) {
    if (out.length >= MAX_METADATA_ROUTES) {
      return;
    }
    const layer = item as ExpressLayer;
    if (layer?.route) {
      const declared = layer.route.methods ?? {};
      const methods = Object.keys(declared).filter((m) => m !== "_all" && declared[m]);
      // `app.all()`: Express 4 marks it `_all`, Express 5 adds every method.
      // Neither declares an endpoint of its own.
      if (declared._all || METHODS.every((m) => declared[m.toLowerCase()])) {
        continue;
      }
      for (const path of routePaths(layer.route.path)) {
        for (const method of methods) {
          const template = expressPathToTemplate(joinPath(prefix, path));
          if (!template) {
            continue;
          }
          const route = { method: method.toUpperCase(), path: template };
          const key = `${route.method} ${route.path}`;
          if (!seen.has(key) && out.length < MAX_METADATA_ROUTES) {
            seen.add(key);
            out.push(route);
          }
        }
      }
      continue;
    }
    const nested = layer?.handle?.stack;
    if (Array.isArray(nested)) {
      const mount = mountPath(layer);
      if (mount !== undefined) {
        walk(nested, joinPath(prefix, mount), out, seen, depth + 1);
      }
    }
  }
}

/**
 * Route templates an Express app declares, as `{method, path}` spelled like
 * the records' `path` (`/orders/:id` → `/orders/{id}`). Routes of routers mounted with `app.use(path,
 * router)` are included with their mount path (Express 5: only routers
 * mounted at `/`; it does not keep other mount paths). At most
 * `MAX_METADATA_ROUTES`. Never throws.
 */
export function listExpressRoutes(app: unknown): AppRoute[] {
  const out: AppRoute[] = [];
  try {
    const stack = rootStack(app);
    if (stack) {
      walk(stack, "", out, new Set(), 0);
    }
  } catch {
    // Route discovery is best effort.
  }
  return out;
}

/** Installed version of `pkg`, resolved from the app's working directory ("" when unknown). */
export function packageVersion(pkg: string): string {
  try {
    const require = createRequire(join(process.cwd(), "noop.js"));
    const version = (require(`${pkg}/package.json`) as { version?: unknown }).version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

/** What a middleware captures, for the effective `config` of the report. */
export type CaptureSettings = {
  captureHeaders: boolean;
  captureRequestBody: boolean;
  captureResponseBody: boolean;
  maxPayloadBytes: number;
  redactor: Redactor;
  excluder: RequestExcluder;
  defaultExclusions: boolean;
  sampleRate: number;
  callbacks: Record<string, boolean>;
};

/** The effective SDK configuration: no secrets, callbacks as booleans. */
export function effectiveConfig(client: ApiLensClient, settings: CaptureSettings): Record<string, unknown> {
  const cfg = client.config;
  return {
    capture_headers: settings.captureHeaders,
    capture_request_body: settings.captureRequestBody,
    capture_response_body: settings.captureResponseBody,
    max_payload_bytes: settings.maxPayloadBytes,
    redact_query_params: [settings.redactor.queryParams.source],
    redact_headers: [settings.redactor.headers.source],
    redact_body_fields: [settings.redactor.bodyFields.source],
    default_exclusions: settings.defaultExclusions,
    exclude_paths: settings.excluder.pathPatterns.map((p) => p.source),
    exclude_user_agents: settings.excluder.userAgentPatterns.map((p) => p.source),
    sample_rate: settings.sampleRate,
    batch_size: cfg.batchSize,
    flush_interval_ms: cfg.flushIntervalMs,
    max_queue_size: cfg.maxQueueSize,
    max_queue_bytes: cfg.maxQueueBytes,
    max_batch_bytes: cfg.maxBatchBytes,
    max_retries: cfg.maxRetries,
    compress: cfg.compress,
    send_heartbeat: cfg.sendHeartbeat,
    heartbeat_interval_ms: cfg.heartbeatIntervalMs,
    callbacks: { ...settings.callbacks, on_stats: typeof cfg.onStats === "function" },
  };
}

/** The `POST /v1/metadata` body for an Express app. */
export function buildExpressMetadata(
  client: ApiLensClient,
  app: unknown,
  { environment, config }: { environment?: string; config: Record<string, unknown> },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    app_id: client.config.appId,
    environment: environment || client.config.environment,
    framework: "express",
    framework_version: packageVersion("express"),
    node_version: process.versions.node,
    sdk_version: SDK_VERSION,
    routes: listExpressRoutes(app),
    config,
  };
  if (client.config.projectSlug) {
    payload.project_slug = client.config.projectSlug;
  }
  return payload;
}
