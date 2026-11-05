import type { NextFunction, Request, Response } from "express";

import type { ApiLensClient } from "./client.js";
import { CaptureCore, recordRequestError, requestError } from "./capture.js";
import { buildExpressMetadata, type FrameworkInfo } from "./metadata.js";
import { expressRouteTemplate } from "./routes.js";
import type { ApiLensConsumer, ApiLensExpressConfig } from "./types.js";

declare module "express-serve-static-core" {
  interface Request {
    apilensConsumer?: ApiLensConsumer | string;
  }

  interface Application {
    apilensClient?: ApiLensClient;
  }
}

export type MiddlewareWithClient = ((req: Request, res: Response, next: NextFunction) => void) & {
  apilensClient: ApiLensClient;
};

function setConsumer(
  req: Request,
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  req.apilensConsumer = consumer || undefined;
}

function trackConsumer(
  req: Request,
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  setConsumer(req, consumer);
}

const errorLayerApps = new WeakSet<object>();

type ExpressLayer = { handle?: unknown };
type ExpressRouter = { stack?: ExpressLayer[] };
type ExpressAppLike = {
  use?: (fn: unknown) => unknown;
  _router?: ExpressRouter;
  router?: ExpressRouter;
};

/** Records the error and passes it on unchanged. Arity 4 marks it as error middleware. */
function apilensErrorRecorder(err: unknown, req: Request, _res: Response, next: NextFunction): void {
  recordRequestError(req, err);
  next(err);
}

/**
 * Put `apilensErrorRecorder` after the app's routes, just before its first
 * error handler following `middleware` (or last), so the error log of a
 * failing request carries the error and its stack. Done on the first
 * request, once all routes exist. It is never inserted at or before the
 * layer being run (that would shift the router's position), so when
 * `middleware` is not on the app's own stack it is appended. Never throws:
 * without it the 5xx log is still sent, without a stack.
 */
function installErrorRecorder(app: unknown, middleware: unknown): void {
  const target = app as ExpressAppLike | undefined;
  if (!target || typeof target.use !== "function" || errorLayerApps.has(target)) {
    return;
  }
  errorLayerApps.add(target);
  try {
    target.use(apilensErrorRecorder);
    let router = target._router;
    if (!router) {
      // Express 5 (`app.router`); Express 4 throws on this getter.
      router = target.router;
    }
    const stack = router?.stack;
    if (!Array.isArray(stack) || stack.length === 0) {
      return;
    }
    const layer = stack.pop() as ExpressLayer;
    const own = stack.findIndex((l) => l?.handle === middleware);
    const firstHandler =
      own === -1
        ? -1
        : stack.findIndex(
            (l, i) => i > own && typeof l?.handle === "function" && l.handle.length === 4,
          );
    if (firstHandler === -1) {
      stack.push(layer);
    } else {
      stack.splice(firstHandler, 0, layer);
    }
  } catch {
    // Leave error capture to the 5xx fallback.
  }
}

function createApiLensMiddleware(options: ApiLensExpressConfig = {}): MiddlewareWithClient {
  return createMiddleware(options);
}

/**
 * The Express middleware; `framework` overrides the framework named in the
 * metadata report (NestJS on its Express platform). @internal
 */
export function createMiddleware(
  options: ApiLensExpressConfig,
  app?: unknown,
  framework?: FrameworkInfo,
): MiddlewareWithClient {
  const core = new CaptureCore(options);
  const client = core.client;
  // App metadata once per process, from `app` when known (useApiLens) or
  // else the first request's `req.app`.
  const reportMetadata = (expressApp: unknown): void => {
    core.reportMetadata(() =>
      buildExpressMetadata(client, expressApp, {
        environment: core.environment,
        config: core.metadataConfig,
      }, framework),
    );
  };
  if (app) {
    reportMetadata(app);
  }

  const middleware = ((req: Request, res: Response, next: NextFunction) => {
    if (!core.metadataReported && req.app) {
      reportMetadata(req.app);
    }
    if (core.captureSpans && req.app) {
      installErrorRecorder(req.app, middleware);
    }
    const capture = core.begin({
      method: req.method,
      url: String(req.originalUrl || req.url || "/"),
      headers: req.headers,
      ip: req.ip || req.socket?.remoteAddress,
    });
    if (!capture) {
      next();
      return;
    }

    // The route is matched after this middleware runs; it is read when the
    // response is sent (see res.end), while req.route / req.baseUrl still
    // describe the handler that answered.
    let routeTemplate: string | undefined;
    let routeResolved = false;
    const resolveRoute = (): void => {
      if (!routeResolved) {
        routeResolved = true;
        routeTemplate = expressRouteTemplate(req, capture.rawPath, core.parametrizeTemplates());
      }
    };
    const contentType = () => res.getHeader("content-type");

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = ((chunk: any, encoding?: any, cb?: any) => {
      capture.addResponseChunk(chunk, encoding, contentType);
      return originalWrite(chunk, encoding, cb);
    }) as typeof res.write;

    res.end = ((chunk: any, encoding?: any, cb?: any) => {
      try {
        resolveRoute();
      } catch (_error) {
        // Never break the response over route resolution.
      }
      capture.addResponseChunk(chunk, encoding, contentType);
      return originalEnd(chunk, encoding, cb);
    }) as typeof res.end;

    res.once("finish", () => {
      try {
        resolveRoute();
      } catch (_error) {
        // Fall back to the raw path.
      }
      capture.finish({
        statusCode: res.statusCode,
        responseHeaders: res.getHeaders(),
        routeTemplate,
        consumer: req.apilensConsumer,
        consumerArgs: [req, res],
        requestBody: req.body,
        error: requestError(req),
      });
    });

    capture.run(() => next());
  }) as MiddlewareWithClient;

  middleware.apilensClient = client;
  return middleware;
}

function useApiLens(app: { use: (mw: MiddlewareWithClient) => void; apilensClient?: ApiLensClient }, config: ApiLensExpressConfig = {}): MiddlewareWithClient {
  const middleware = createMiddleware(config, app);
  app.use(middleware);
  app.apilensClient = middleware.apilensClient;
  return middleware;
}

const createExpressMiddleware = createApiLensMiddleware;
const instrumentExpress = useApiLens;

export {
  createApiLensMiddleware,
  createExpressMiddleware,
  instrumentExpress,
  setConsumer,
  trackConsumer,
  useApiLens,
};
