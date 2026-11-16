import "reflect-metadata";

import Router from "@koa/router";
import {
  Catch,
  Controller,
  Get,
  Module,
  UseGuards,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type INestApplication,
} from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import Koa from "koa";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import { apiLensFastify } from "../src/fastify.js";
import { instrumentHono } from "../src/hono.js";
import { apiLensKoa } from "../src/koa.js";
import { ApiLensModule } from "../src/nestjs.js";
import type { ApiLensExpressConfig } from "../src/types.js";

/**
 * Errors a user-installed error handler turns into a 500 response (Express
 * error middleware in a sub-router, a Fastify `setErrorHandler`, a Nest
 * exception filter, a Koa try/catch middleware, Hono `onError`) still ship
 * their full stack in the request's ERROR log, exactly once.
 */

type Call = { url: string; body: Record<string, any> };

type Harness = {
  /** Send `GET <path>` and return the response status and body. */
  hit: (path: string) => Promise<{ status: number; body: unknown }>;
  close: () => Promise<void>;
};

function config(calls: Call[]): ApiLensExpressConfig {
  return {
    apiKey: "test-api-key",
    appId: "test-app",
    environment: "test",
    batchSize: 1000,
    compress: false,
    sampleRate: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(String(options?.body || "{}")) });
      return new Response(null, { status: 202 });
    },
  };
}

function sent(calls: Call[], path: string, key: string): Array<Record<string, any>> {
  return calls
    .filter((c) => new URL(c.url).pathname === path)
    .flatMap((c) => (c.body[key] || []) as Array<Record<string, any>>);
}

/** A handled-error response body; the error itself never reaches the response. */
const HANDLED = { error: "something went wrong" };

/** Deep frame so the stack names a function of this file. */
function chargeCard(): never {
  throw new TypeError("card declined");
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await ApiLensClient.shutdown();
});

async function expectHandledStack(calls: Call[], path: string): Promise<void> {
  const res = await harness!.hit(path);
  expect(res.status).toBe(500);
  expect(res.body).toEqual(HANDLED);
  await vi.waitFor(async () => {
    await ApiLensClient.getInstance().flushAll();
    expect(sent(calls, "/v1/requests", "requests")).toHaveLength(1);
    expect(sent(calls, "/v1/logs", "logs").length).toBeGreaterThanOrEqual(1);
  });
  const [record] = sent(calls, "/v1/requests", "requests");
  const logs = sent(calls, "/v1/logs", "logs");
  expect(record).toMatchObject({ status_code: 500, sampled: true });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    level: "ERROR",
    message: "TypeError: card declined",
    logger_name: "apilens.exception",
    status_code: 500,
  });
  expect(logs[0].payload).toContain("chargeCard");
  expect(logs[0].payload).toContain("handled-errors.test.ts");
}

describe("Express", () => {
  function start(): Harness {
    const app = express();
    useApiLens(app, config(calls));
    const api = express.Router();
    api.get("/charge", () => chargeCard());
    // The sub-router's own error middleware answers; the app never sees the error.
    api.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json(HANDLED);
    });
    app.use("/api", api);
    app.get("/rethrow", () => chargeCard());
    // A first handler that swaps the error for another; the original is kept.
    app.use((_err: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next(new Error("wrapped"));
    });
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json(HANDLED);
    });
    return {
      hit: async (path) => {
        const res = await request(app).get(path);
        return { status: res.status, body: res.body };
      },
      close: async () => {},
    };
  }
  let calls: Call[];

  it("error middleware inside a sub-router: stack still shipped", async () => {
    calls = [];
    harness = start();
    await expectHandledStack(calls, "/api/charge");
  });

  it("an error handler that replaces the error: the raised error is shipped", async () => {
    calls = [];
    harness = start();
    await expectHandledStack(calls, "/rethrow");
  });
});

describe("Fastify", () => {
  it("setErrorHandler answering with a plain body: stack still shipped", async () => {
    const calls: Call[] = [];
    const fastify = Fastify();
    await fastify.register(apiLensFastify, config(calls));
    fastify.setErrorHandler((_error, _request, reply) => {
      reply.code(500).send(HANDLED);
    });
    fastify.get("/charge", async () => chargeCard());
    harness = {
      hit: async (path) => {
        const res = await fastify.inject({ method: "GET", url: path });
        return { status: res.statusCode, body: res.json() };
      },
      close: () => fastify.close(),
    };
    await expectHandledStack(calls, "/charge");
  });

  it("setErrorHandler of an encapsulated plugin: stack still shipped", async () => {
    const calls: Call[] = [];
    const fastify = Fastify();
    await fastify.register(apiLensFastify, config(calls));
    await fastify.register(
      async (child) => {
        child.setErrorHandler(async (_error, _request, reply) => {
          reply.code(500);
          return HANDLED;
        });
        child.get("/charge", async () => chargeCard());
      },
      { prefix: "/v1" },
    );
    harness = {
      hit: async (path) => {
        const res = await fastify.inject({ method: "GET", url: path });
        return { status: res.statusCode, body: res.json() };
      },
      close: () => fastify.close(),
    };
    await expectHandledStack(calls, "/v1/charge");
  });
});

class Explodes implements CanActivate {
  canActivate(): boolean {
    chargeCard();
  }
}

@Catch()
class AllErrorsFilter implements ExceptionFilter {
  catch(_exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    if (typeof response.code === "function") {
      response.code(500).send(HANDLED);
    } else {
      response.status(500).json(HANDLED);
    }
  }
}

@Controller()
class ChargeController {
  @Get("charge")
  charge(): never {
    chargeCard();
  }

  @Get("guarded")
  @UseGuards(Explodes)
  guarded(): string {
    return "never";
  }
}

async function nestApp(calls: Call[], adapter: ExpressAdapter | FastifyAdapter): Promise<Harness> {
  @Module({
    imports: [ApiLensModule.forRoot(config(calls))],
    controllers: [ChargeController],
    providers: [{ provide: APP_FILTER, useClass: AllErrorsFilter }],
  })
  class AppModule {}

  const app: INestApplication = await NestFactory.create(AppModule, adapter, { logger: false });
  await app.init();
  if (adapter instanceof FastifyAdapter) {
    await adapter.getInstance().ready();
  }
  return {
    hit: async (path) => {
      const res = await request(app.getHttpServer()).get(path);
      return { status: res.status, body: res.body };
    },
    close: () => app.close(),
  };
}

describe.each([
  { name: "express", adapter: () => new ExpressAdapter() },
  { name: "fastify", adapter: () => new FastifyAdapter() },
])("NestJS ($name) with a global exception filter", ({ adapter }) => {
  it("a handler's error: stack still shipped", async () => {
    const calls: Call[] = [];
    harness = await nestApp(calls, adapter());
    await expectHandledStack(calls, "/charge");
  });

  it("a guard's error (outside interceptors): stack still shipped", async () => {
    const calls: Call[] = [];
    harness = await nestApp(calls, adapter());
    await expectHandledStack(calls, "/guarded");
  });
});

describe("Koa", () => {
  it("a try/catch error middleware that answers: stack still shipped", async () => {
    const calls: Call[] = [];
    const app = new Koa();
    app.silent = true;
    app.use(apiLensKoa(config(calls)));
    app.use(async (ctx, next) => {
      try {
        await next();
      } catch {
        ctx.status = 500;
        ctx.body = HANDLED;
      }
    });
    const router = new Router();
    router.get("/charge", () => chargeCard());
    app.use(router.routes());
    harness = {
      hit: async (path) => {
        const res = await request(app.callback()).get(path);
        return { status: res.status, body: res.body };
      },
      close: async () => {},
    };
    await expectHandledStack(calls, "/charge");
  });
});

describe("Hono", () => {
  it("app.onError answering: stack still shipped", async () => {
    const calls: Call[] = [];
    const app = new Hono();
    instrumentHono(app, config(calls));
    app.get("/charge", () => chargeCard());
    app.onError((_err, c) => c.json(HANDLED, 500));
    harness = {
      hit: async (path) => {
        const res = await app.request(path);
        return { status: res.status, body: await res.json() };
      },
      close: async () => {},
    };
    await expectHandledStack(calls, "/charge");
  });

  it("a sub-app's onError: stack still shipped", async () => {
    const calls: Call[] = [];
    const app = new Hono();
    instrumentHono(app, config(calls));
    const api = new Hono();
    api.get("/charge", () => chargeCard());
    api.onError((_err, c) => c.json(HANDLED, 500));
    app.route("/api", api);
    harness = {
      hit: async (path) => {
        const res = await app.request(path);
        return { status: res.status, body: await res.json() };
      },
      close: async () => {},
    };
    await expectHandledStack(calls, "/api/charge");
  });
});
