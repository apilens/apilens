/**
 * Fastify adapter: a plugin that captures every request of the app.
 *
 * ```ts
 * import Fastify from "fastify";
 * import { apiLensFastify, setConsumer } from "apilens-js-sdk/fastify";
 *
 * const app = Fastify();
 * await app.register(apiLensFastify, { apiKey: process.env.APILENS_API_KEY, appId: "orders-api" });
 * ```
 *
 * Hooks: `onRequest` starts the capture (and the trace), `preHandler`
 * re-enters the trace after body parsing, `onSend` reads the response
 * payload, `onError` keeps the error for the 5xx error log and `onResponse`
 * records the request with the matched route template
 * (`request.routeOptions.url`, `:id` spelled `{id}`). The plugin skips
 * Fastify's encapsulation, so it covers every route of the app however it is
 * registered. Recording itself is the shared capture core (`capture.ts`).
 */
// Node builtins for the core (see runtime.ts); first, before the core runs.
import "./node.js";
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from "fastify";

import type { ApiLensClient } from "./client.js";
import { CaptureCore, recordRequestError, requestError, type RequestCapture } from "./capture.js";
import { buildAppMetadata, packageVersion, type AppRoute, type FrameworkInfo } from "./metadata.js";
import { expressPathToTemplate } from "./routes.js";
import type { ApiLensConsumer, ApiLensExpressConfig } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    apilensConsumer?: ApiLensConsumer | string | null;
  }

  interface FastifyInstance {
    apilensClient?: ApiLensClient;
  }
}

/** Options of the Fastify plugin: the same as the Express middleware's. */
export type ApiLensFastifyConfig = ApiLensExpressConfig;

const captures = new WeakMap<FastifyRequest, RequestCapture>();

/** Attach a consumer to the request; it is sent with the request's record. */
function setConsumer(
  request: FastifyRequest,
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  request.apilensConsumer = consumer || null;
}

/**
 * Fastify route URL → `{name}` template: `/users/:id` → `/users/{id}`,
 * `/files/*` → `/files/{*}`; regex constraints (`:id(^\\d+)`) are dropped.
 */
export function fastifyPathToTemplate(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) {
    return undefined;
  }
  const template = expressPathToTemplate(url.replace(/(^|\/)\*$/, "$1:__apilens_wildcard"));
  return template ? template.replace("{__apilens_wildcard}", "{*}") : undefined;
}

function methodsOf(route: RouteOptions): string[] {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  return methods.map((m) => String(m).toUpperCase());
}

/**
 * Instrument a Fastify instance; `framework` overrides the framework named
 * in the metadata report (NestJS on its Fastify platform). Must run before
 * the routes are registered (they are collected for the metadata report).
 * @internal
 */
export function attachFastify(
  fastify: FastifyInstance,
  config: ApiLensFastifyConfig = {},
  framework?: FrameworkInfo,
): ApiLensClient {
  const core = new CaptureCore(config);
  const client = core.client;

  // Route templates for the metadata report, sent once the app is ready.
  const routes: AppRoute[] = [];
  const seen = new Set<string>();
  fastify.addHook("onRoute", (route) => {
    const path = fastifyPathToTemplate(route.url);
    if (!path) {
      return;
    }
    for (const method of methodsOf(route)) {
      const key = `${method} ${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        routes.push({ method, path });
      }
    }
  });
  fastify.addHook("onReady", (done) => {
    core.reportMetadata(() => {
      // HEAD routes Fastify adds for every GET are not declared endpoints.
      const gets = new Set(routes.filter((r) => r.method === "GET").map((r) => r.path));
      const declared = routes.filter((r) => !(r.method === "HEAD" && gets.has(r.path)));
      return buildAppMetadata(
        client,
        framework ?? { name: "fastify", version: packageVersion("fastify") },
        declared,
        { environment: core.environment, config: core.metadataConfig },
      );
    });
    done();
  });

  if (!fastify.hasRequestDecorator("apilensConsumer")) {
    fastify.decorateRequest("apilensConsumer", null);
  }
  if (!fastify.hasDecorator("apilensClient")) {
    fastify.decorate("apilensClient", client);
  }

  fastify.addHook("onRequest", (request, _reply, done) => {
    const capture = core.begin({
      method: request.method,
      url: request.url,
      headers: request.headers,
      ip: request.ip,
    });
    if (!capture) {
      done();
      return;
    }
    captures.set(request, capture);
    capture.run(() => done());
  });

  // Body parsing runs outside the trace's async context; re-enter it so the
  // handler's outbound calls are child spans of the request.
  fastify.addHook("preHandler", (request, _reply, done) => {
    const capture = captures.get(request);
    if (capture) {
      capture.run(() => done());
    } else {
      done();
    }
  });

  fastify.addHook("onError", (request, _reply, error, done) => {
    recordRequestError(request.raw, error);
    done();
  });

  fastify.addHook("onSend", (request, reply, payload, done) => {
    captures
      .get(request)
      ?.addResponseChunk(payload, undefined, () => reply.getHeader("content-type"));
    done(null, payload);
  });

  fastify.addHook("onResponse", (request: FastifyRequest, reply: FastifyReply, done) => {
    const capture = captures.get(request);
    if (capture) {
      captures.delete(request);
      let routeTemplate: string | undefined;
      try {
        routeTemplate = fastifyPathToTemplate(request.routeOptions?.url);
      } catch {
        // Fall back to the raw path.
      }
      capture.finish({
        statusCode: reply.statusCode,
        responseHeaders: reply.getHeaders(),
        routeTemplate,
        consumer: request.apilensConsumer,
        consumerArgs: [request, reply],
        requestBody: request.body,
        error: requestError(request.raw),
      });
    }
    done();
  });

  return client;
}

/** Instrument a Fastify instance directly (no `register`); returns its client. */
function instrumentFastify(
  fastify: FastifyInstance,
  config: ApiLensFastifyConfig = {},
): ApiLensClient {
  return attachFastify(fastify, config);
}

/**
 * The Fastify plugin: `app.register(apiLensFastify, config)`. It skips
 * encapsulation (like `fastify-plugin`), so register it at the root before
 * the routes.
 */
const apiLensFastify: FastifyPluginCallback<ApiLensFastifyConfig> = Object.assign(
  (fastify: FastifyInstance, options: ApiLensFastifyConfig, done: (err?: Error) => void) => {
    try {
      attachFastify(fastify, options);
      done();
    } catch (error) {
      done(error as Error);
    }
  },
  {
    [Symbol.for("skip-override")]: true,
    [Symbol.for("fastify.display-name")]: "apilens",
  },
);

export { apiLensFastify, instrumentFastify, setConsumer };
