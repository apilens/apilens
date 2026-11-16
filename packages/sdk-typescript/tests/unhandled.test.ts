/**
 * Process-level and manual exception capture (issue #916): `captureException`
 * ties the exception log to the current request's trace, and the
 * `uncaughtException` / `unhandledRejection` listeners (`captureUnhandled`)
 * ship the error and flush it without changing Node's exit behaviour.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ApiLensClient, captureException } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import { beginRequestTrace, runWithTrace } from "../src/trace.js";
import type { ApiLensClientConfig, ApiLensLogRecord } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

afterEach(async () => {
  process.env.APILENS_CAPTURE_SPANS = "false";
  await ApiLensClient.shutdown();
});

function makeClient(overrides: ApiLensClientConfig = {}) {
  const bodies: string[] = [];
  const client = new ApiLensClient({
    apiKey: "test-key",
    appId: "worker",
    environment: "test",
    compress: false,
    logger: {},
    flushIntervalMs: 60_000,
    fetchImpl: async (url, init) => {
      bodies.push(`${String(url)} ${String(init?.body)}`);
      return new Response(null, { status: 202 });
    },
    ...overrides,
  });
  return { client, bodies };
}

describe("captureException", () => {
  it("inside a request carries that request's trace and span id", async () => {
    const { client } = makeClient();
    const ctx = beginRequestTrace(undefined);
    await runWithTrace(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      captureException(new Error("handled", { cause: new Error("root") }));
    });
    expect(client.logQueue).toHaveLength(1);
    const log = client.logQueue[0] as ApiLensLogRecord;
    expect(log.trace_id).toBe(ctx.traceId);
    expect(log.span_id).toBe(ctx.spanId);
    expect(log.level).toBe("ERROR");
    expect(log.logger_name).toBe("apilens.exception");
    expect(log.message).toBe("Error: handled");
    expect(log.payload).toContain("Caused by: Error: root");
    expect(log.attributes).toMatchObject({
      "exception.type": "Error",
      "exception.message": "handled",
      "exception.chain_depth": "1",
      "exception.mechanism": "captureException",
    });
    expect(log.app_id).toBe("worker");
    expect(log.environment).toBe("test");
  });

  it("in an Express handler shares the request record's trace id", async () => {
    delete process.env.APILENS_CAPTURE_SPANS;
    const calls: Array<{ url: string; body: Record<string, Array<Record<string, unknown>>> }> = [];
    const app = express();
    const mw = useApiLens(app, {
      apiKey: "test-key",
      appId: "checkout",
      compress: false,
      batchSize: 1000,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
        return new Response(null, { status: 202 });
      },
    });
    app.get("/pay", async (_req, res) => {
      await Promise.resolve();
      try {
        throw new TypeError("card declined");
      } catch (error) {
        captureException(error, { level: "WARN" });
      }
      res.json({ ok: false });
    });

    await request(app).get("/pay").expect(200);
    await mw.apilensClient.flushAll();

    const requests = calls.filter((c) => c.url.endsWith("/requests")).flatMap((c) => c.body.requests);
    const logs = calls.filter((c) => c.url.endsWith("/logs")).flatMap((c) => c.body.logs);
    expect(requests).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(logs[0].trace_id).toBe(requests[0].trace_id);
    expect(logs[0].span_id).toBe(requests[0].span_id);
    expect(logs[0].level).toBe("WARN");
    expect(logs[0].message).toBe("TypeError: card declined");
  });

  it("outside a request is sent without a trace id", () => {
    const { client } = makeClient();
    captureException("plain string");
    const log = client.logQueue[0] as ApiLensLogRecord;
    expect(log.trace_id).toBe("");
    expect(log.message).toBe("Error: plain string");
    expect(log.attributes?.["exception.type"]).toBe("string");
  });

  it("is a no-op before init and while capture is off", () => {
    expect(() => captureException(new Error("early"))).not.toThrow();
    const { client } = makeClient({ enabled: false });
    captureException(new Error("off"));
    expect(client.logQueue).toHaveLength(0);
  });
});

describe("process listeners (app handles the error)", () => {
  // Vitest has its own uncaughtException / unhandledRejection listeners, so
  // here the app is in charge: the SDK ships the error and the process runs on.
  it("ships an unhandled rejection and starts the flush", async () => {
    const { client, bodies } = makeClient();
    expect(process.listeners("unhandledRejection").some((l) => l.name === "onUnhandledRejection")).toBe(true);
    const reason = new Error("rejected", { cause: new Error("db down") });
    process.emit("unhandledRejection", reason, Promise.resolve());
    await vi.waitFor(() => expect(bodies.some((b) => b.includes("/logs"))).toBe(true));
    const body = JSON.parse(bodies.find((b) => b.includes("/logs"))!.split(" ").slice(1).join(" "));
    expect(body.logs[0]).toMatchObject({
      level: "ERROR",
      logger_name: "apilens.exception",
      message: "Error: rejected",
      attributes: { "exception.mechanism": "unhandledRejection", "exception.chain_depth": "1" },
    });
    expect(body.logs[0].payload).toContain("Caused by: Error: db down");
    expect(ApiLensClient.current()).toBe(client);
  });

  it("ships an uncaught exception once, however many times it is reported", async () => {
    const { client } = makeClient();
    client.stop();
    const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
    const error = new RangeError("out of range");
    emit("uncaughtException", error, "uncaughtException");
    emit("uncaughtException", error, "uncaughtException");
    await vi.waitFor(() => expect(client.hasPending()).toBe(false));
    expect(client.stats().sentRecords).toBe(1);
  });

  it("installs no listeners with captureUnhandled: false", () => {
    const before = process.listeners("uncaughtException").length;
    makeClient({ captureUnhandled: false });
    // Listeners are per process: one installed by an earlier client may remain.
    expect(process.listeners("uncaughtException").length).toBe(before);
  });
});

// ── Exit semantics, in a real child process ─────────────────────────────────

type Child = { code: number | null; stderr: string; logs: Array<Record<string, unknown>> };

describe("process exit semantics (child process)", () => {
  let outDir = "";
  let sdkUrl = "";
  let server: http.Server;
  let baseUrl = "";
  const received: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "apilens-unhandled-"));
    const { build } = await import("tsup");
    await build({
      entry: { index: join(here, "..", "src", "index.ts") },
      format: ["esm"],
      outDir,
      dts: false,
      sourcemap: false,
      silent: true,
      config: false,
      platform: "node",
    });
    sdkUrl = pathToFileURL(join(outDir, "index.js")).href;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url?.endsWith("/logs")) {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { logs: Array<Record<string, unknown>> };
          received.push(...body.logs.map((log) => ({ ...log, from: req.headers["x-test-run"] })));
        }
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    if (outDir) {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  let runs = 0;

  /** Run `body` in a fresh Node with the SDK initialised; logs it shipped are returned. */
  async function run(body: string, opts: { options?: string; execArgv?: string[] } = {}): Promise<Child> {
    runs += 1;
    const script = join(outDir, `run-${runs}.mjs`);
    writeFileSync(
      script,
      `import { ApiLensClient } from ${JSON.stringify(sdkUrl)};
const marker = ${JSON.stringify(`run-${runs}`)};
new ApiLensClient({
  apiKey: "test-key",
  appId: "worker",
  baseUrl: ${JSON.stringify(baseUrl)},
  compress: false,
  sendHeartbeat: false,
  sendMetadata: false,
  flushIntervalMs: 60000,
  logger: {},
  fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, "x-test-run": marker } }),
  ${opts.options ?? ""}
});
${body}
`,
    );
    const child = spawn(process.execPath, [...(opts.execArgv ?? []), script], {
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    const marker = `run-${runs}`;
    return { code, stderr, logs: received.filter((log) => log.from === marker) };
  }

  it("unhandled rejection: shipped, flushed, then the process still crashes with code 1", async () => {
    const out = await run(`
setTimeout(() => {}, 100000);
Promise.reject(new Error("job failed", { cause: new Error("db down") }));
`);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("job failed");
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0]).toMatchObject({
      level: "ERROR",
      logger_name: "apilens.exception",
      message: "Error: job failed",
      attributes: expect.objectContaining({ "exception.mechanism": "unhandledRejection" }),
    });
    expect(String(out.logs[0].payload)).toContain("Caused by: Error: db down");
  }, 30_000);

  it("unhandled rejection of a non-Error: crashes like Node (ERR_UNHANDLED_REJECTION)", async () => {
    const out = await run(`Promise.reject("nope");`);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("ERR_UNHANDLED_REJECTION");
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0].message).toBe("Error: nope");
  }, 30_000);

  it("uncaught exception: shipped, flushed, then exit code 1", async () => {
    const out = await run(`
setTimeout(() => { throw new TypeError("background job crashed"); }, 5);
setTimeout(() => {}, 100000);
`);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("TypeError: background job crashed");
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0].attributes).toMatchObject({ "exception.mechanism": "uncaughtException" });
  }, 30_000);

  it("same exit code as without the SDK listeners (captureUnhandled: false)", async () => {
    const out = await run(`Promise.reject(new Error("job failed"));`, { options: "captureUnhandled: false," });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("job failed");
    expect(out.logs).toHaveLength(0);
  }, 30_000);

  it("the app's own unhandledRejection listener stays in charge (no crash)", async () => {
    const out = await run(`
process.on("unhandledRejection", () => {});
Promise.reject(new Error("ignored by the app"));
`);
    expect(out.code).toBe(0);
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0].message).toBe("Error: ignored by the app");
  }, 30_000);

  it("the app's own uncaughtException listener gets a rejection in throw mode", async () => {
    const out = await run(`
process.on("uncaughtException", (err, origin) => { console.error("app saw", origin, err.message); });
Promise.reject(new Error("raised to the app"));
`);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("app saw unhandledRejection raised to the app");
    expect(out.logs).toHaveLength(1);
  }, 30_000);

  it("--unhandled-rejections=warn: warns and keeps running, as without the SDK", async () => {
    const out = await run(`Promise.reject(new Error("only a warning"));`, {
      execArgv: ["--unhandled-rejections=warn"],
    });
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("only a warning");
    expect(out.logs).toHaveLength(1);
  }, 30_000);

  it("--unhandled-rejections=strict: crashes with code 1 after shipping", async () => {
    const out = await run(`setTimeout(() => {}, 100000);\nPromise.reject(new Error("strict"));`, {
      execArgv: ["--unhandled-rejections=strict"],
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("strict");
    expect(out.logs).toHaveLength(1);
  }, 30_000);
});
