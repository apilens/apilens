import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import {
  ENV_PARAMETRIZE_PATHS,
  expressPathToTemplate,
  expressRouteTemplate,
  parametrizeEnabled,
  parametrizePath,
  resolveEndpointPath,
} from "../src/routes.js";
import type { ApiLensExpressConfig } from "../src/types.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await ApiLensClient.shutdown();
});

describe("parametrizePath", () => {
  it.each([
    ["/product/123", "/product/{id}"],
    ["/users/550e8400-e29b-41d4-a716-446655440000", "/users/{uuid}"],
    ["/events/01ARZ3NDEKTSV4RRFFQ69G5FAV", "/events/{id}"],
    ["/docs/659f1e0c8b3a4d2e1f0a9b7c", "/docs/{hash}"],
    ["/keys/abcDEF123456ghiJKL", "/keys/{id}"],
    ["/orders/42/items/7", "/orders/{id}/items/{id}"],
  ])("%s -> %s", (raw, template) => {
    expect(parametrizePath(raw)).toBe(template);
  });

  it("keeps ordinary segments", () => {
    for (const path of ["/", "", "/settings", "/openapi.json", "/v2/report.p12", "/a/b/"]) {
      expect(parametrizePath(path)).toBe(path || "/");
    }
  });
});

describe("parametrizeEnabled", () => {
  it("defaults on and honours the kill switch", () => {
    expect(parametrizeEnabled({})).toBe(true);
    for (const off of ["0", "false", "No", " OFF "]) {
      expect(parametrizeEnabled({ [ENV_PARAMETRIZE_PATHS]: off })).toBe(false);
    }
    expect(parametrizeEnabled({ [ENV_PARAMETRIZE_PATHS]: "true" })).toBe(true);
  });
});

describe("expressPathToTemplate", () => {
  it.each([
    ["/users/:id", "/users/{id}"],
    ["/users/:userId/orders/:orderId", "/users/{userId}/orders/{orderId}"],
    ["/files/*path", "/files/{path}"],
    ["/posts{/:slug}", "/posts/{slug}"],
    ["/items/:id(\\d+)", "/items/{id}"],
    ["/items/:id?", "/items/{id}"],
    ["/v1\\:batch", "/v1:batch"],
    ["/", "/"],
  ])("%s -> %s", (route, template) => {
    expect(expressPathToTemplate(route)).toBe(template);
  });

  it("is undefined for RegExp and array routes", () => {
    expect(expressPathToTemplate(/^\/x/)).toBeUndefined();
    expect(expressPathToTemplate(["/a", "/b"])).toBeUndefined();
  });
});

describe("expressRouteTemplate", () => {
  it("joins the mount path and the route path", () => {
    expect(expressRouteTemplate({ baseUrl: "/api", route: { path: "/users/:id" } }, "/api/users/9"))
      .toBe("/api/users/{id}");
    expect(expressRouteTemplate({ baseUrl: "/api", route: { path: "/" } }, "/api")).toBe("/api");
  });

  it("parametrizes id segments of a filled-in mount path", () => {
    const req = { baseUrl: "/teams/42", route: { path: "/members/:memberId" } };
    expect(expressRouteTemplate(req, "/teams/42/members/7")).toBe("/teams/{id}/members/{memberId}");
    expect(expressRouteTemplate(req, "/teams/42/members/7", false)).toBe("/teams/42/members/{memberId}");
  });

  it("discards a stale route that does not fit the raw path", () => {
    expect(expressRouteTemplate({ baseUrl: "", route: { path: "/:id" } }, "/users/42")).toBeUndefined();
    expect(expressRouteTemplate({ baseUrl: "" }, "/users/42")).toBeUndefined();
  });
});

describe("resolveEndpointPath", () => {
  it("prefers the template, then the heuristic, then the raw path", () => {
    expect(resolveEndpointPath("/p/{pid}", "/p/1")).toBe("/p/{pid}");
    expect(resolveEndpointPath(undefined, "/p/1")).toBe("/p/{id}");
    expect(resolveEndpointPath(undefined, "/p/1", false)).toBe("/p/1");
    vi.stubEnv(ENV_PARAMETRIZE_PATHS, "false");
    expect(resolveEndpointPath(undefined, "/p/1")).toBe("/p/1");
    expect(resolveEndpointPath("/p/{pid}", "/p/1")).toBe("/p/{pid}");
  });
});

type Sent = { path: string; raw_path: string; status_code: number };

function appWithCapture(config: ApiLensExpressConfig = {}) {
  const bodies: string[] = [];
  const app = express();
  useApiLens(app, {
    apiKey: "test-api-key",
    appId: "test-app",
    batchSize: 100,
    compress: false,
    fetchImpl: async (_url, options) => {
      bodies.push(String(options?.body || ""));
      return new Response(null, { status: 200 });
    },
    ...config,
  });
  const records = async (): Promise<Sent[]> => {
    await ApiLensClient.getInstance().flushAll();
    return bodies.flatMap((body) => JSON.parse(body).requests as Sent[]);
  };
  return { app, records };
}

describe("Express path templating", () => {
  it("groups ids under the route template and keeps the raw path", async () => {
    const { app, records } = appWithCapture();
    app.get("/product/:id", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/product/123").expect(200);
    await request(app).get("/product/324?color=red").expect(200);

    const sent = await records();
    expect(sent.map((r) => r.path)).toEqual(["/product/{id}", "/product/{id}"]);
    expect(sent.map((r) => r.raw_path)).toEqual(["/product/123", "/product/324?color=red"]);
  });

  it("redacts sensitive query values on raw_path only", async () => {
    const { app, records } = appWithCapture({ redactQueryParams: ["^session$"] });
    app.get("/search", (_req, res) => {
      res.send("ok");
    });

    await request(app).get("/search?q=shoes&token=abc&session=s1").expect(200);

    const [rec] = await records();
    expect(rec.path).toBe("/search");
    expect(rec.raw_path).toBe("/search?q=shoes&token=[redacted]&session=[redacted]");
  });

  it("resolves routes inside mounted and nested routers", async () => {
    const { app, records } = appWithCapture();
    const orders = express.Router();
    orders.get("/:orderId", (_req, res) => {
      res.json({});
    });
    const users = express.Router();
    users.get("/", (_req, res) => {
      res.json([]);
    });
    users.get("/:userId", (_req, res) => {
      res.json({});
    });
    users.use("/:userId/orders", orders);
    app.use("/api/users", users);

    await request(app).get("/api/users").expect(200);
    await request(app).get("/api/users/abc").expect(200);
    await request(app).get("/api/users/17/orders/9001").expect(200);

    const sent = await records();
    expect(sent.map((r) => [r.path, r.raw_path])).toEqual([
      ["/api/users", "/api/users"],
      ["/api/users/{userId}", "/api/users/abc"],
      ["/api/users/{id}/orders/{orderId}", "/api/users/17/orders/9001"],
    ]);
  });

  it("falls back to the heuristic when no route matched", async () => {
    const { app, records } = appWithCapture();

    await request(app).get("/missing/42?x=1").expect(404);

    const [rec] = await records();
    expect(rec.path).toBe("/missing/{id}");
    expect(rec.raw_path).toBe("/missing/42?x=1");
  });

  it("keeps the raw path when parametrizePaths is false", async () => {
    const { app, records } = appWithCapture({ parametrizePaths: false });
    app.get("/product/:id", (_req, res) => {
      res.json({});
    });

    await request(app).get("/missing/42").expect(404);
    await request(app).get("/product/5").expect(200);

    const sent = await records();
    expect(sent.map((r) => r.path)).toEqual(["/missing/42", "/product/{id}"]);
  });

  it("honours APILENS_PARAMETRIZE_PATHS=false over code", async () => {
    vi.stubEnv(ENV_PARAMETRIZE_PATHS, "false");
    const { app, records } = appWithCapture({ parametrizePaths: true });

    await request(app).get("/missing/42").expect(404);

    const [rec] = await records();
    expect(rec.path).toBe("/missing/42");
  });
});
