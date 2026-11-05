/**
 * Hono adapter: a middleware that captures every request of the app, on Node
 * (`@hono/node-server`), Bun, Deno and edge runtimes (Cloudflare Workers,
 * Vercel Edge).
 *
 * ```ts
 * import { Hono } from "hono";
 * import { instrumentHono, setConsumer } from "apilens-js-sdk/hono";
 *
 * const app = new Hono();
 * instrumentHono(app, { apiKey: env.APILENS_API_KEY, appId: "orders-api" });
 * app.get("/orders/:id", (c) => c.json({ id: c.req.param("id") }));
 * ```
 *
 * This entry point imports no `node:` module: Node builtins are used when the
 * runtime has them (found by feature detection, see `runtime.ts`), else the
 * Web-standard fallbacks are (`crypto.getRandomValues`, `CompressionStream`).
 * On an edge runtime the client runs in inline flush mode (no timers): each
 * request's records are sent at its end, through `executionCtx.waitUntil()`
 * when the runtime has it so the response is not held up.
 *
 * The request is grouped by the Hono route that answered it
 * (`c.req.routePath`, `:id` spelled `{id}`); an error a handler threw
 * (`c.error`) goes in the 5xx error log. The bodies are read from clones of
 * the Fetch `Request` / `Response`, only when they are captured.
 */
import type { ApiLensClient } from "./client.js";
import { CaptureCore, type RequestCapture } from "./capture.js";
import { buildAppMetadata, packageVersion, type AppRoute } from "./metadata.js";
import { isEdgeRuntime } from "./runtime.js";
import type { HeaderMap } from "./sanitize.js";
import type { ApiLensConsumer, ApiLensExpressConfig } from "./types.js";

/** Options of the Hono middleware: the Express middleware's, with these changes. */
export type ApiLensHonoConfig = Omit<ApiLensExpressConfig, "flushMode"> & {
  /**
   * `"auto"` (default): `"inline"` on an edge runtime (Cloudflare Workers,
   * Vercel Edge, no Node `process`), else `"background"`. `"inline"` sends
   * each request's records at its end and runs no timers; `"background"`
   * batches them from timers like the Node adapters.
   */
  flushMode?: "auto" | "inline" | "background";
  /**
   * Keeps the runtime alive for the end-of-request work (reading the
   * response body, recording, the inline flush) after the response is
   * returned. Defaults to `c.executionCtx.waitUntil` when the runtime
   * provides one (Cloudflare Workers); pass e.g. `waitUntil` from
   * `@vercel/functions` on Vercel. Without one, inline mode finishes that
   * work before the response is returned.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
};

/** The parts of a Hono `Context` the middleware uses. */
export type HonoContextLike = {
  req: {
    raw: Request;
    url: string;
    method: string;
    routeIndex?: number;
    matchedRoutes?: Array<{ path?: string; method?: string }>;
  };
  res: Response;
  error?: unknown;
  env?: unknown;
  readonly executionCtx?: { waitUntil?: (promise: Promise<unknown>) => void };
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
};

export type HonoMiddleware = ((c: any, next: () => Promise<void>) => Promise<void>) & {
  apilensClient: ApiLensClient;
};

type HonoAppLike = {
  use: (path: string, ...handlers: any[]) => unknown;
  routes?: Array<{ path?: string; method?: string }>;
};

const CONSUMER_KEY = "apilensConsumer";

/** Attach a consumer to the request (`c.set`); it is sent with the request's record. */
function setConsumer(
  c: { set: (key: any, value: any) => void },
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  c.set(CONSUMER_KEY, consumer || undefined);
}

// `:name`, an optional `{regex}` constraint (one level of nested braces) and `?`.
const HONO_PARAM_RE = /:([A-Za-z_$][\w$-]*)(?:\{(?:\\.|[^{}\\]|\{[^{}]*\})*\})?\??/g;

/**
 * Hono route path → `{name}` template: `/users/:id` → `/users/{id}`,
 * `/posts/:id{[0-9]+}` → `/posts/{id}`, `/files/*` → `/files/{*}`.
 */
export function honoPathToTemplate(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) {
    return undefined;
  }
  return path
    .replace(HONO_PARAM_RE, (_m, name: string) => `{${name}}`)
    .replace(/(^|\/)\*(?=\/|$)/g, "$1{*}");
}

/**
 * The template of the route that answered, or undefined when none did: the
 * chain ended at this middleware (404) or at a catch-all middleware (`*`,
 * `/api/*`) that answered itself (auth, not found).
 */
export function honoRouteTemplate(c: HonoContextLike, ownIndex: number | undefined): string | undefined {
  const index = c.req.routeIndex;
  if (typeof index !== "number" || index === ownIndex) {
    return undefined;
  }
  // `matchedRoutes` (Hono >= 4.3), else the deprecated `routePath`.
  let route: { path?: string; method?: string } | undefined;
  const matched = c.req.matchedRoutes;
  if (Array.isArray(matched)) {
    route = matched[index];
  } else {
    route = { path: (c.req as { routePath?: string }).routePath };
  }
  const path = route?.path;
  if (!path || path === "*" || path === "/*" || (route?.method === "ALL" && path.endsWith("*"))) {
    return undefined;
  }
  return honoPathToTemplate(path);
}

/** Fetch `Headers` → lower-case header map (`set-cookie` kept as a list). */
export function headersToMap(headers: Headers): HeaderMap {
  const out: HeaderMap = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(headers);
    if (cookies.length > 0) {
      out["set-cookie"] = cookies;
    }
  }
  return out;
}

/**
 * Read `stream` chunk by chunk into `onChunk`, stopping (and cancelling the
 * stream) once `limit` bytes are in. Never throws.
 */
async function drain(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: Uint8Array) => void,
  limit: number,
): Promise<void> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  let total = 0;
  let complete = false;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        onChunk(value);
      }
    }
  } catch {
    // A failed or cancelled body: keep what was read.
  } finally {
    if (!complete) {
      reader.cancel().catch(() => undefined);
    }
  }
}

/** Reads the request body prefix when it is captured. Never throws. */
async function readRequestBody(c: HonoContextLike, capture: RequestCapture): Promise<Uint8Array | undefined> {
  const raw = c.req.raw;
  if (!raw.body || raw.bodyUsed || !capture.capturesRequestBody(raw.headers.get("content-type") || "")) {
    return undefined;
  }
  const max = capture.maxPayloadBytes;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    await drain(
      raw.clone().body,
      (chunk) => {
        const part = chunk.subarray(0, max - size);
        parts.push(part);
        size += part.byteLength;
      },
      max,
    );
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function clientIp(c: HonoContextLike): string | undefined {
  const headers = c.req.raw.headers;
  const ip = headers.get("cf-connecting-ip") || headers.get("fly-client-ip") || headers.get("true-client-ip");
  if (ip) {
    return ip;
  }
  // @hono/node-server exposes the Node request as `c.env.incoming`.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress || undefined;
}

/** The runtime's `waitUntil` (Cloudflare `executionCtx`), when there is one. */
function runtimeWaitUntil(c: HonoContextLike): ((promise: Promise<unknown>) => void) | undefined {
  try {
    // Hono's getter throws when the runtime gave no ExecutionContext.
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function") {
      return (promise) => ctx.waitUntil?.(promise);
    }
  } catch {
    // No execution context (Node, Bun, Deno, tests).
  }
  return undefined;
}

/** The middleware; `app` (from instrumentHono) supplies the routes of the metadata report. @internal */
export function createHonoMiddleware(config: ApiLensHonoConfig = {}, app?: HonoAppLike): HonoMiddleware {
  const { flushMode = "auto", waitUntil, ...options } = config;
  const inline = flushMode === "inline" || (flushMode === "auto" && isEdgeRuntime());
  const core = new CaptureCore({ ...options, flushMode: inline ? "inline" : "background" });
  const client = core.client;

  core.reportMetadata(() => {
    const routes: AppRoute[] = [];
    const seen = new Set<string>();
    for (const route of app?.routes || []) {
      // `ALL` entries are `app.use()` middleware, this one included.
      const method = String(route?.method || "").toUpperCase();
      const path = honoPathToTemplate(route?.path);
      if (!path || !method || method === "ALL") {
        continue;
      }
      const key = `${method} ${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        routes.push({ method, path });
      }
    }
    return buildAppMetadata(
      client,
      { name: "hono", version: packageVersion("hono") },
      routes,
      { environment: core.environment, config: core.metadataConfig },
    );
  });

  const middleware = (async (c: HonoContextLike, next: () => Promise<void>) => {
    let capture: RequestCapture | undefined;
    try {
      const url = new URL(c.req.url);
      capture = core.begin({
        method: c.req.method,
        url: `${url.pathname}${url.search}`,
        headers: headersToMap(c.req.raw.headers) as Record<string, string>,
        ip: clientIp(c),
      });
    } catch (error) {
      client.config.logger.debug?.("API Lens could not start capturing a Hono request", error);
    }
    if (!capture) {
      await next();
      return;
    }
    const ownIndex = c.req.routeIndex;
    const requestBody = await readRequestBody(c, capture);

    await capture.run(() => next());

    const res = c.res;
    let routeTemplate: string | undefined;
    try {
      routeTemplate = honoRouteTemplate(c, ownIndex);
    } catch {
      // Fall back to the raw path.
    }
    const defer = waitUntil ?? runtimeWaitUntil(c);
    // Without a waitUntil, inline mode must finish before the response is
    // returned, so it reads at most the captured prefix of the body.
    const readToEnd = Boolean(defer) || !inline;
    const responseHeaders = headersToMap(res.headers);
    const contentType = res.headers.get("content-type") || "";
    const capturing = res.status !== 101 && capture.capturesResponseBody(contentType);
    let bodyStream: ReadableStream<Uint8Array> | null = null;
    if (res.body && res.status !== 101 && (capturing || readToEnd)) {
      try {
        bodyStream = res.clone().body;
      } catch {
        bodyStream = null;
      }
    }
    const recorded = capture;
    const done = (async () => {
      // Counted for response_size; buffered (up to maxPayloadBytes) when captured.
      await drain(
        bodyStream,
        (chunk) => recorded.addResponseChunk(chunk, undefined, () => contentType),
        readToEnd ? Number.POSITIVE_INFINITY : recorded.maxPayloadBytes,
      );
      recorded.finish({
        statusCode: res.status,
        responseHeaders,
        routeTemplate,
        consumer: c.get?.(CONSUMER_KEY) as ApiLensConsumer | string | undefined,
        consumerArgs: [c, res],
        requestBody,
        error: c.error,
      });
      if (inline) {
        await client.flushInline();
      }
    })().catch((error) => {
      client.config.logger.debug?.("API Lens could not record a Hono request", error);
    });

    if (defer) {
      try {
        defer(done);
        return;
      } catch {
        // Fall through.
      }
    }
    if (inline) {
      await done;
    }
  }) as HonoMiddleware;

  middleware.apilensClient = client;
  return middleware;
}

/** The Hono middleware: `app.use("*", apiLensHono(config))`, before the routes. */
function apiLensHono(config: ApiLensHonoConfig = {}): HonoMiddleware {
  return createHonoMiddleware(config);
}

/**
 * Mount the middleware on every path of `app` (call it before the routes)
 * and list the app's routes in the metadata report; returns the client.
 */
function instrumentHono(app: HonoAppLike, config: ApiLensHonoConfig = {}): ApiLensClient {
  const middleware = createHonoMiddleware(config, app);
  app.use("*", middleware);
  return middleware.apilensClient;
}

export { apiLensHono, instrumentHono, setConsumer };
