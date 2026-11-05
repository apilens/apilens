/**
 * NestJS adapter: a global module plus an interceptor.
 *
 * ```ts
 * import { Module } from "@nestjs/common";
 * import { ApiLensModule } from "apilens-js-sdk/nestjs";
 *
 * @Module({
 *   imports: [ApiLensModule.forRoot({ apiKey: process.env.APILENS_API_KEY, appId: "orders-api" })],
 * })
 * export class AppModule {}
 * ```
 *
 * `ApiLensModule.forRoot()` instruments the app's HTTP platform as the
 * application is created, before Nest registers its routes: on
 * `@nestjs/platform-express` it mounts the Express middleware, on
 * `@nestjs/platform-fastify` it attaches the Fastify hooks. Route templates
 * come from those adapters (Nest routes are ordinary Express / Fastify
 * routes). `ApiLensInterceptor`, installed globally by the module, keeps the
 * error a handler throws so the error log of a 5xx carries its stack (Nest's
 * exception filter answers before Express / Fastify see the error).
 */
// Node builtins for the core (see runtime.ts); first, before the core runs.
import "./node.js";
import type {
  CallHandler,
  DynamicModule,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import { APP_INTERCEPTOR, HttpAdapterHost } from "@nestjs/core";
import { tap, type Observable } from "rxjs";

import type { ApiLensClient } from "./client.js";
import { recordRequestError } from "./capture.js";
import { createMiddleware } from "./express.js";
import { attachFastify } from "./fastify.js";
import { packageVersion, type FrameworkInfo } from "./metadata.js";
import type { ApiLensConsumer, ApiLensExpressConfig } from "./types.js";

/** Options of `ApiLensModule.forRoot`: the same as the Express middleware's. */
export type ApiLensNestConfig = ApiLensExpressConfig;

/** Injection token of the module's `ApiLensClient`. */
export const APILENS_CLIENT = "APILENS_CLIENT";

type HttpAdapterLike = {
  getType(): string;
  getInstance(): unknown;
};

function nestFramework(): FrameworkInfo {
  return { name: "nestjs", version: packageVersion("@nestjs/core") };
}

/**
 * Instrument the platform behind Nest's HTTP adapter (Express or Fastify).
 * Runs while the module's providers are created, before Nest mounts its body
 * parsers and routes. Throws on any other platform.
 */
function instrumentHttpAdapter(adapter: HttpAdapterLike, config: ApiLensNestConfig): ApiLensClient {
  const type = adapter.getType();
  const instance = adapter.getInstance();
  if (type === "express") {
    const app = instance as { use: (mw: unknown) => void; apilensClient?: ApiLensClient };
    const middleware = createMiddleware(config, app, nestFramework());
    app.use(middleware);
    app.apilensClient = middleware.apilensClient;
    return middleware.apilensClient;
  }
  if (type === "fastify") {
    return attachFastify(instance as Parameters<typeof attachFastify>[0], config, nestFramework());
  }
  throw new Error(`API Lens: unsupported NestJS HTTP platform "${type}" (express or fastify)`);
}

/**
 * Keeps the error a route handler throws for the request's error log. Bound
 * globally by `ApiLensModule`; HTTP requests only.
 */
export class ApiLensInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<{ raw?: object } | undefined>();
    // The Express request is the Node request; Fastify wraps it in `raw`.
    const raw = request?.raw ?? request;
    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          if (raw) {
            recordRequestError(raw, error);
          }
        },
      }),
    );
  }
}

/** The API Lens module; import `ApiLensModule.forRoot(config)` once, in the root module. */
export class ApiLensModule {
  static forRoot(config: ApiLensNestConfig = {}): DynamicModule {
    return {
      module: ApiLensModule,
      global: true,
      providers: [
        {
          provide: APILENS_CLIENT,
          useFactory: (host: HttpAdapterHost) => {
            const adapter = host.httpAdapter as HttpAdapterLike | undefined;
            if (!adapter) {
              throw new Error("API Lens: ApiLensModule needs an HTTP application (NestFactory.create)");
            }
            return instrumentHttpAdapter(adapter, config);
          },
          inject: [HttpAdapterHost],
        },
        { provide: APP_INTERCEPTOR, useValue: new ApiLensInterceptor() },
      ],
      exports: [APILENS_CLIENT],
    };
  }
}

/**
 * Attach a consumer to the request (`@Req()`, Express or Fastify); it is sent
 * with the request's record.
 */
export function setConsumer(
  request: object,
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  (request as { apilensConsumer?: ApiLensConsumer | string | null }).apilensConsumer =
    consumer || null;
}
