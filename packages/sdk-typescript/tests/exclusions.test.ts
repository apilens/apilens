import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiLensClient } from "../src/client.js";
import {
  DEFAULT_EXCLUDED_PATHS,
  DEFAULT_EXCLUDED_USER_AGENTS,
  ENV_EXCLUDE_PATHS,
  RequestExcluder,
  splitPatterns,
} from "../src/exclusions.js";
import { useApiLens } from "../src/express.js";
import type { ApiLensExpressConfig } from "../src/types.js";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_EXCLUDE_PATHS];
  delete process.env[ENV_EXCLUDE_PATHS];
});

afterEach(async () => {
  if (savedEnv === undefined) {
    delete process.env[ENV_EXCLUDE_PATHS];
  } else {
    process.env[ENV_EXCLUDE_PATHS] = savedEnv;
  }
  await ApiLensClient.shutdown();
});

describe("default lists", () => {
  it("is the same default list as the Python SDK (Apitally set)", () => {
    expect([...DEFAULT_EXCLUDED_PATHS]).toEqual([
      "/_?healthz?$",
      "/_?health[-_]?checks?$",
      "/_?heart[-_]?beats?$",
      "/ping$",
      "/ready$",
      "/live$",
      "/favicon(?:-[\\w-]+)?\\.(?:ico|png|svg)$",
      "/apple-touch-icon(?:-[\\w-]+)?\\.png$",
      "/robots\\.txt$",
      "/sitemap\\.xml$",
      "/manifest\\.json$",
      "/site\\.webmanifest$",
      "/service-worker\\.js$",
      "/sw\\.js$",
      "/\\.well-known/",
    ]);
    expect([...DEFAULT_EXCLUDED_USER_AGENTS]).toEqual([
      "health[-_ ]?check",
      "microsoft-azure-application-lb",
      "googlehc",
      "kube-probe",
    ]);
  });

  const excluder = new RequestExcluder();

  // One or more hits for every default path pattern, in list order.
  it.each([
    "/health",
    "/healthz",
    "/_health",
    "/_healthz",
    "/HEALTHZ",
    "/healthz?full=1",
    "/api/v1/healthz",
    "/health_checks",
    "/health-check",
    "/healthcheck",
    "/_health_check",
    "/heartbeat",
    "/heart-beats",
    "/_heart_beat",
    "/ping",
    "/ready",
    "/live",
    "/favicon.ico",
    "/favicon-32x32.png",
    "/favicon.svg",
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/robots.txt",
    "/sitemap.xml",
    "/manifest.json",
    "/site.webmanifest",
    "/service-worker.js",
    "/sw.js",
    "/.well-known/openid-configuration",
    "/.well-known/acme-challenge/abc",
  ])("excludes %s by default", (path) => {
    expect(excluder.matchesPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/orders",
    "/healthy",
    "/health/details",
    "/pinged",
    "/already",
    "/lives",
    "/favicon.gif",
    "/robots.txt.bak",
    "/well-known/x",
    "/orders?path=/health",
  ])("keeps %s by default", (path) => {
    expect(excluder.matchesPath(path)).toBe(false);
  });

  it.each([
    "ELB-HealthChecker/2.0",
    "Consul Health Check",
    "health_check",
    "Microsoft-Azure-Application-LB/AGI",
    "GoogleHC/1.0",
    "kube-probe/1.29",
  ])("excludes user agent %s by default", (ua) => {
    expect(excluder.matchesUserAgent(ua)).toBe(true);
  });

  it.each(["Mozilla/5.0", "curl/8.4.0", "", undefined])(
    "keeps user agent %s by default",
    (ua) => {
      expect(excluder.matchesUserAgent(ua)).toBe(false);
    },
  );

  it("defaultExclusions: false turns every default off", () => {
    const off = new RequestExcluder({ defaultExclusions: false });
    expect(off.pathPatterns).toHaveLength(0);
    expect(off.userAgentPatterns).toHaveLength(0);
    expect(off.shouldExclude("/healthz", "kube-probe/1.29")).toBe(false);
  });
});

describe("user patterns", () => {
  it("matches case-insensitively with ^/$ anchoring to the path", () => {
    const ex = new RequestExcluder({
      defaultExclusions: false,
      excludePaths: ["^/internal$", "metrics"],
    });
    expect(ex.matchesPath("/INTERNAL")).toBe(true);
    expect(ex.matchesPath("/internal?x=1")).toBe(true);
    expect(ex.matchesPath("/internalz")).toBe(false);
    expect(ex.matchesPath("/api/internal")).toBe(false);
    expect(ex.matchesPath("/svc/metrics/cpu")).toBe(true);
    expect(ex.matchesPath("/orders?q=metrics")).toBe(false);
  });

  it("accepts RegExp objects and keeps test() stateless", () => {
    const ex = new RequestExcluder({ defaultExclusions: false, excludePaths: [/^\/status$/g] });
    expect(ex.matchesPath("/Status")).toBe(true);
    expect(ex.matchesPath("/status")).toBe(true);
  });

  it("adds custom user-agent patterns on top of the defaults", () => {
    const ex = new RequestExcluder({ excludeUserAgents: "uptimerobot, pingdom" });
    expect(ex.matchesUserAgent("Mozilla/5.0 (compatible; UptimeRobot/2.0)")).toBe(true);
    expect(ex.matchesUserAgent("Pingdom.com_bot")).toBe(true);
    expect(ex.matchesUserAgent("kube-probe/1.29")).toBe(true);
    expect(ex.matchesUserAgent("Mozilla/5.0")).toBe(false);
  });

  it("splitPatterns accepts comma strings and arrays", () => {
    expect(splitPatterns(" ^/a$ , ,^/b$ ")).toEqual(["^/a$", "^/b$"]);
    expect(splitPatterns(["^/a$", "", " ^/b$ "])).toEqual(["^/a$", "^/b$"]);
    expect(splitPatterns(null)).toEqual([]);
  });

  it("APILENS_EXCLUDE_PATHS adds patterns", () => {
    process.env[ENV_EXCLUDE_PATHS] = "^/internal$,^/debug$";
    const ex = new RequestExcluder({ defaultExclusions: false });
    expect(ex.matchesPath("/debug")).toBe(true);
    expect(ex.matchesPath("/Internal")).toBe(true);
    expect(ex.matchesPath("/orders")).toBe(false);
    expect(new RequestExcluder({ defaultExclusions: false, includeEnv: false }).matchesPath("/debug")).toBe(false);
  });

  it("throws on an invalid regex at construction", () => {
    expect(() => new RequestExcluder({ excludePaths: ["(unclosed"] })).toThrow(SyntaxError);
    expect(() => new RequestExcluder({ excludeUserAgents: ["[bad"] })).toThrow(SyntaxError);
  });
});

describe("Express middleware", () => {
  function buildApp(config: Partial<ApiLensExpressConfig> = {}) {
    const ingestCalls: string[] = [];
    const seen: { wrapped?: boolean } = {};
    const app = express();
    app.use(express.json());
    const mw = useApiLens(app, {
      apiKey: "test-api-key",
      projectSlug: "test-project",
      appId: "test-app",
      batchSize: 100,
      fetchImpl: async (_url, options) => {
        ingestCalls.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
      ...config,
    });
    const handler = (req: express.Request, res: express.Response) => {
      // The middleware replaces res.write/res.end with own-property wrappers
      // when it buffers the response; excluded requests keep the prototype's.
      seen.wrapped =
        Object.prototype.hasOwnProperty.call(res, "write") ||
        Object.prototype.hasOwnProperty.call(res, "end");
      res.status(200).json({ ok: true, body: req.body });
    };
    app.all("/{*path}", handler);
    return { app, ingestCalls, seen, client: mw.apilensClient };
  }

  async function records(client: ApiLensClient, ingestCalls: string[]) {
    await client.flushAll();
    return ingestCalls.flatMap((c) => JSON.parse(c).requests as Array<{ path: string }>);
  }

  it("excludes default health paths without wrapping or buffering", async () => {
    const { app, ingestCalls, seen, client } = buildApp();
    await request(app).post("/healthz?probe=1").send({ big: "x".repeat(1000) }).expect(200);
    expect(seen.wrapped).toBe(false);
    expect(await records(client, ingestCalls)).toHaveLength(0);
  });

  it("excludes default probe user agents", async () => {
    const { app, ingestCalls, seen, client } = buildApp();
    await request(app).get("/orders").set("User-Agent", "kube-probe/1.29").expect(200);
    expect(seen.wrapped).toBe(false);
    expect(await records(client, ingestCalls)).toHaveLength(0);
  });

  it("captures non-excluded requests normally", async () => {
    const { app, ingestCalls, seen, client } = buildApp();
    await request(app).get("/orders").set("User-Agent", "Mozilla/5.0").expect(200);
    expect(seen.wrapped).toBe(true);
    const sent = await records(client, ingestCalls);
    expect(sent).toHaveLength(1);
  });

  it("applies custom excludePaths and excludeUserAgents", async () => {
    const { app, ingestCalls, client } = buildApp({
      excludePaths: ["^/internal/"],
      excludeUserAgents: ["uptimerobot"],
    });
    await request(app).get("/internal/cache").expect(200);
    await request(app).get("/orders").set("User-Agent", "UptimeRobot/2.0").expect(200);
    await request(app).get("/orders").set("User-Agent", "Mozilla/5.0").expect(200);
    const sent = await records(client, ingestCalls);
    expect(sent).toHaveLength(1);
  });

  it("defaultExclusions: false records health checks", async () => {
    const { app, ingestCalls, client } = buildApp({ defaultExclusions: false });
    await request(app).get("/healthz").expect(200);
    await request(app).get("/orders").set("User-Agent", "kube-probe/1.29").expect(200);
    const sent = await records(client, ingestCalls);
    expect(sent).toHaveLength(2);
  });

  it("throws on an invalid regex when the middleware is created", () => {
    expect(() => buildApp({ excludePaths: ["(bad"] })).toThrow(SyntaxError);
  });
});
