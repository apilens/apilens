/**
 * Koa adapter: a middleware that captures every request of the app.
 *
 * ```ts
 * import Koa from "koa";
 * import Router from "@koa/router";
 * import { apiLensKoa, setConsumer } from "apilens-js-sdk/koa";
 *
 * const app = new Koa();
 * const router = new Router();
 * app.use(apiLensKoa({ apiKey: process.env.APILENS_API_KEY, appId: "orders-api", routers: [router] }));
 * app.use(router.routes());
 * ```
 *
 * Mount it first, before the body parser and the routers. The capture starts
 * (and the trace is entered) when the request arrives; the response bytes are
 * read as Koa writes them to `ctx.res`, and the request is recorded once the
 * response has been sent, grouped by the `@koa/router` route that matched
 * (`ctx._matchedRoute`, `:id` spelled `{id}`). An error thrown downstream is
 * kept for the 5xx error log and rethrown unchanged. Recording itself is the
 * shared capture core (`capture.ts`).
 */
// Node builtins for the core (see runtime.ts); first, before the core runs.
import "./node.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiLensClient } from "./client.js";
import { CaptureCore, recordRequestError, requestError } from "./capture.js";
import { buildAppMetadata, packageVersion, type AppRoute } from "./metadata.js";
import { expressPathToTemplate } from "./routes.js";
import type { ApiLensConsumer, ApiLensExpressConfig } from "./types.js";

/** A `@koa/router` instance, for the routes of the metadata report. */
export type KoaRouterLike = {
  stack?: Array<{ path?: unknown; methods?: unknown }>;
};

/** Options of the Koa middleware: the Express middleware's, plus `routers`. */
export type ApiLensKoaConfig = ApiLensExpressConfig & {
  /**
   * The app's `@koa/router` routers. Their routes are listed in the app
   * metadata report; requests are grouped by route template without them.
   */
  routers?: KoaRouterLike[];
};

/** The parts of a Koa context the middleware uses. */
export type KoaContextLike = {
  method: string;
  originalUrl?: string;
  url: string;
  headers: IncomingMessage["headers"];
  ip?: string;
  req: IncomingMessage;
  res: ServerResponse;
  status?: number;
  state: Record<string, unknown>;
  request: { body?: unknown };
  response: unknown;
  _matchedRoute?: unknown;
};

export type KoaMiddleware = ((ctx: KoaContextLike, next: () => Promise<unknown>) => Promise<void>) & {
  apilensClient: ApiLensClient;
};

const CONSUMER_KEY = "apilensConsumer";

/** Attach a consumer to the request (`ctx.state`); it is sent with the request's record. */
function setConsumer(
  ctx: { state: Record<string, unknown> },
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  ctx.state[CONSUMER_KEY] = consumer || undefined;
}

/**
 * `@koa/router` route path → `{name}` template: `/users/:id` → `/users/{id}`,
 * `/files/*path` → `/files/{path}`, `/a{/:b}` → `/a/{b}`. Undefined for a
 * RegExp route or when no route matched.
 */
export function koaRouteTemplate(matchedRoute: unknown): string | undefined {
  return expressPathToTemplate(matchedRoute) || undefined;
}

/** Routes of `@koa/router` routers for the metadata report (HEAD of a GET skipped). */
export function listKoaRoutes(routers: KoaRouterLike[] | undefined): AppRoute[] {
  const out: AppRoute[] = [];
  const seen = new Set<string>();
  try {
    for (const router of routers || []) {
      for (const layer of router?.stack || []) {
        const path = koaRouteTemplate(layer?.path);
        const methods = Array.isArray(layer?.methods) ? layer.methods.map((m) => String(m).toUpperCase()) : [];
        if (!path) {
          continue;
        }
        for (const method of methods) {
          if (method === "HEAD" && methods.includes("GET")) {
            continue;
          }
          const key = `${method} ${path}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ method, path });
          }
        }
      }
    }
  } catch {
    // Route discovery is best effort.
  }
  return out;
}

/** The Koa middleware. Mount it first: `app.use(apiLensKoa(config))`. */
function apiLensKoa(config: ApiLensKoaConfig = {}): KoaMiddleware {
  const { routers, ...options } = config;
  const core = new CaptureCore(options);
  const client = core.client;
  // Built once the app has had time to register its routes (see client.reportMetadata).
  core.reportMetadata(() =>
    buildAppMetadata(
      client,
      { name: "koa", version: packageVersion("koa") },
      listKoaRoutes(routers),
      { environment: core.environment, config: core.metadataConfig },
    ),
  );

  const middleware = (async (ctx: KoaContextLike, next: () => Promise<unknown>) => {
    const capture = core.begin({
      method: ctx.method,
      url: String(ctx.originalUrl || ctx.url || "/"),
      headers: ctx.headers,
      ip: ctx.ip || ctx.req?.socket?.remoteAddress,
    });
    if (!capture) {
      await next();
      return;
    }

    const res = ctx.res;
    const contentType = () => res.getHeader("content-type");
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    res.write = ((chunk: any, encoding?: any, cb?: any) => {
      capture.addResponseChunk(chunk, encoding, contentType);
      return originalWrite(chunk, encoding, cb);
    }) as typeof res.write;
    res.end = ((chunk: any, encoding?: any, cb?: any) => {
      if (typeof chunk !== "function") {
        capture.addResponseChunk(chunk, encoding, contentType);
      }
      return originalEnd(chunk, encoding, cb);
    }) as typeof res.end;

    const finish = (): void => {
      let routeTemplate: string | undefined;
      try {
        routeTemplate = koaRouteTemplate(ctx._matchedRoute);
      } catch {
        // Fall back to the raw path.
      }
      capture.finish({
        statusCode: res.statusCode,
        responseHeaders: res.getHeaders(),
        routeTemplate,
        consumer: ctx.state?.[CONSUMER_KEY] as ApiLensConsumer | string | undefined,
        consumerArgs: [ctx, ctx.response],
        requestBody: ctx.request?.body,
        error: requestError(ctx.req),
      });
    };
    // `close` covers a client that went away before the response finished.
    res.once("finish", finish);
    res.once("close", finish);

    try {
      await capture.run(() => next());
    } catch (error) {
      // Koa's error handler answers the request; the error goes in the 5xx log.
      recordRequestError(ctx.req, error);
      throw error;
    }
  }) as KoaMiddleware;

  middleware.apilensClient = client;
  return middleware;
}

/** Mount the middleware on `app` (first) and expose its client as `app.context.apilensClient`. */
function instrumentKoa(
  app: { use: (mw: KoaMiddleware) => unknown; context?: Record<string, unknown> },
  config: ApiLensKoaConfig = {},
): ApiLensClient {
  const middleware = apiLensKoa(config);
  app.use(middleware);
  if (app.context) {
    app.context.apilensClient = middleware.apilensClient;
  }
  return middleware.apilensClient;
}

export { apiLensKoa, instrumentKoa, setConsumer };
