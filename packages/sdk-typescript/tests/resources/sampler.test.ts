/**
 * Resource sampler core (C1, #1106) and freeze handling (C8, #1113): the
 * window, collector isolation, the cost budget, the remote policy, the
 * contract shape, edge runtimes, worker threads and scripts that must exit.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/node.js";
import { ApiLensClient } from "../../src/client.js";
import { parseResourcesPolicy } from "../../src/policy.js";
import { ResourceSampler } from "../../src/resources/sampler.js";
import type { Collector, ResourcesBlock, SampleContext } from "../../src/resources/types.js";
import { requestSchema, spec, validate } from "../contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const repo = join(pkg, "..", "..");
const FIXTURES = join(repo, "testdata");
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

/** A collector scripted by the test. */
function fake(name: Collector["name"], sample: (ctx: SampleContext) => void, drain: (out: ResourcesBlock) => void = () => {}): Collector {
  return { name, capability: name, available: () => true, sample, drain };
}

/** A sampler with hand-driven clocks and no timer. */
function manual(collectors?: Collector[], extra: ConstructorParameters<typeof ResourceSampler>[0] = {}) {
  const clock = { now: 0, wall: 1_700_000_000_000, cost: 0 };
  const sampler = new ResourceSampler({
    timers: false,
    linux: false,
    hostCores: 4,
    collectors,
    now: () => {
      const t = clock.now;
      clock.now += clock.cost;
      return t;
    },
    wallNow: () => clock.wall,
    ...extra,
  });
  const advance = (ms: number) => {
    clock.now += ms;
    clock.wall += ms;
  };
  return { sampler, clock, advance };
}

/**
 * Every dotted key path of a JSON value (array items share their parent's
 * path). With `nullGauges`, a null field also stands for its gauge keys: the
 * minimal fixture's `"external": null` is the gauge the SDK did not measure.
 */
function paths(value: unknown, prefix = "", nullGauges = false): string[] {
  if (value === null && nullGauges) {
    return ["min", "avg", "max", "last"].map((k) => `${prefix}.${k}`);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => paths(item, `${prefix}[]`, nullGauges));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...paths(v, `${prefix}.${k}`, nullGauges)]);
  }
  return [];
}

describe("window and collectors", () => {
  it("drains a v1 block with n, window_s and the sampler's cost", () => {
    const { sampler, clock, advance } = manual([
      fake("process.memory", () => {}, (out) => {
        out.process = { memory: { rss: { min: 1, avg: 1, max: 1, last: 1 } } };
      }),
    ]);
    clock.cost = 0.05; // 50 µs per clock read
    sampler.start();
    advance(15_000);
    sampler.sampleNow();
    advance(15_000);
    const block = sampler.drain();
    expect(block).toMatchObject({ v: 1, n: 2, window_s: 30, capabilities: ["process.memory"], limit_source: "host", flags: [] });
    expect(block?.sampler_cost_us).toBeGreaterThan(0);
  });

  it("isolates a failing collector and turns it off after 5 failures in a row", () => {
    let good = 0;
    const { sampler } = manual([
      fake("pools", () => {
        throw new Error("boom");
      }),
      fake("runtime", () => {
        good += 1;
      }),
    ]);
    sampler.start();
    for (let i = 0; i < 6; i += 1) {
      expect(() => sampler.sampleNow()).not.toThrow();
    }
    expect(good).toBe(7);
    expect(sampler.errorCounts()).toEqual({ pools: 5 });
    expect(sampler.isCollectorOff("pools")).toBe(true);
    expect(sampler.drain()?.capabilities).toEqual(["runtime"]);
  });

  it("a collector that throws in drain never breaks the heartbeat", () => {
    const { sampler } = manual([
      fake("pools", () => {}, () => {
        throw new Error("boom");
      }),
    ]);
    sampler.start();
    expect(sampler.drain()).toMatchObject({ v: 1, capabilities: [] });
  });

  it("backs off while one sample costs more than 0.1 % of a core", () => {
    const { sampler, clock } = manual([fake("runtime", () => {})]);
    clock.cost = 40; // 40 ms per sample: over the 15 ms budget of 15 s, then the 30 ms of 30 s
    sampler.start();
    expect(sampler.intervalMs).toBe(30_000);
    sampler.sampleNow();
    expect(sampler.intervalMs).toBe(60_000);
    clock.cost = 0;
    sampler.sampleNow();
    expect(sampler.intervalMs).toBe(30_000);
  });

  it("never samples faster than 15 s", () => {
    expect(new ResourceSampler({ intervalMs: 1000, timers: false }).intervalMs).toBe(15_000);
    expect(new ResourceSampler({ intervalMs: 30_000, timers: false }).intervalMs).toBe(30_000);
  });

  it("inline mode samples only when an interval has passed", () => {
    let n = 0;
    const { sampler, advance } = manual([fake("runtime", () => {
      n += 1;
    })]);
    sampler.start();
    sampler.sampleIfDue();
    advance(5_000);
    sampler.sampleIfDue();
    expect(n).toBe(1);
    advance(10_000);
    sampler.sampleIfDue();
    expect(n).toBe(2);
  });

  it("shares one drained window between heartbeats of several apps", () => {
    const { sampler, advance } = manual([fake("runtime", () => {})]);
    sampler.start();
    advance(15_000);
    const a = sampler.drain();
    const b = sampler.drain();
    expect(b).toEqual(a);
    advance(15_000);
    expect(sampler.drain()?.n).toBeUndefined();
  });
});

describe("freeze gap (C8)", () => {
  it("flags a wall-clock jump over 2x the interval and keeps CPU undiluted", async () => {
    const { ProcessCpuCollector } = await import("../../src/resources/process.js");
    const { sampler, advance } = manual([new ProcessCpuCollector()]);
    sampler.start(); // baseline
    advance(15_000);
    sampler.sampleNow(); // a normal step
    const normal = sampler.drain();
    expect(normal?.flags).toEqual([]);
    expect(normal?.process?.cpu?.cores_used).toBeDefined();

    advance(600_000); // frozen for 10 minutes (Lambda between invocations)
    sampler.sampleNow();
    const frozen = sampler.drain();
    expect(frozen?.flags).toContain("freeze_gap");
    // The frozen step is not averaged in: no CPU value at all, rather than ~0.
    expect(frozen?.process?.cpu).toBeUndefined();

    advance(15_000);
    sampler.sampleNow();
    const after = sampler.drain();
    expect(after?.flags).toEqual([]);
    expect(after?.process?.cpu?.cores_used).toBeDefined();
  });

  it("flags lambda and cloud run windows serverless", () => {
    const { sampler } = manual([], { platform: "lambda" });
    sampler.start();
    expect(sampler.drain()?.flags).toEqual(["serverless"]);
  });

  it("labels a PM2 / cluster worker with NODE_APP_INSTANCE", () => {
    const { sampler } = manual([], { env: { NODE_APP_INSTANCE: "3" } });
    sampler.start();
    expect(sampler.drain()?.flags).toEqual(["node_app_instance.3"]);
  });
});

describe("remote policy (narrow only)", () => {
  it("parses policy.resources and ignores unknown collectors", () => {
    expect(parseResourcesPolicy({ enabled: false, min_interval_s: 60, disabled_collectors: ["pools", "argv", 3] })).toEqual({
      enabled: false, minIntervalS: 60, disabledCollectors: ["pools"],
    });
    expect(parseResourcesPolicy(undefined)).toBeUndefined();
    expect(parseResourcesPolicy({})).toEqual({ enabled: true, minIntervalS: 0, disabledCollectors: [] });
  });

  it("enabled=false stops sampling and the block; enabled again resumes", () => {
    let n = 0;
    const { sampler, advance } = manual([fake("runtime", () => {
      n += 1;
    })]);
    sampler.start();
    sampler.applyPolicy({ enabled: false, minIntervalS: 0, disabledCollectors: [] });
    advance(15_000);
    sampler.sampleNow();
    expect(n).toBe(1);
    expect(sampler.drain()).toBeUndefined();
    sampler.applyPolicy(undefined);
    expect(n).toBe(2);
    expect(sampler.drain()).toMatchObject({ v: 1, n: 1 });
  });

  it("lengthens the interval, never shortens it", () => {
    const { sampler } = manual([], { intervalMs: 30_000 });
    sampler.applyPolicy({ enabled: true, minIntervalS: 60, disabledCollectors: [] });
    expect(sampler.intervalMs).toBe(60_000);
    sampler.applyPolicy({ enabled: true, minIntervalS: 15, disabledCollectors: [] });
    expect(sampler.intervalMs).toBe(30_000);
  });

  it("skips disabled collectors and drops their capability", () => {
    let pools = 0;
    const { sampler } = manual([
      fake("pools", () => {
        pools += 1;
      }, (out) => {
        out.pools = [{ name: "default" }];
      }),
      fake("runtime", () => {}),
    ]);
    sampler.applyPolicy({ enabled: true, minIntervalS: 0, disabledCollectors: ["pools"] });
    sampler.start();
    const block = sampler.drain();
    expect(pools).toBe(0);
    expect(block?.capabilities).toEqual(["runtime"]);
    expect(block?.pools).toBeUndefined();
  });
});

describe("contract shape", () => {
  afterEach(async () => {
    await ApiLensClient.shutdown();
  });

  const golden = [
    ...paths(JSON.parse(readFileSync(join(FIXTURES, "resources/heartbeat_v1.json"), "utf8")).resources, "", true),
    ...paths(JSON.parse(readFileSync(join(FIXTURES, "resources/heartbeat_v1_minimal.json"), "utf8")).resources, "", true),
  ];
  const goldenSet = new Set(golden);

  it("a container sample (k8s fixture) validates and uses only fixture fields", async () => {
    const sampler = new ResourceSampler({
      timers: false,
      linux: true,
      hostCores: 8,
      root: join(FIXTURES, "cgroup/v2_k8s_nested/root"),
    });
    sampler.start();
    sampler.sampleNow();
    const block = sampler.drain();
    sampler.stop();
    expect(block?.limit_source).toBe("cgroup_v2");
    expect(block?.container?.container_id).toBe("3f4e9c2b1a0d8e7f6c5b4a3928170f6e5d4c3b2a1908f7e6d5c4b3a291807f6e");
    expect(block?.container?.memory).toMatchObject({ limit: 536870912, current: { last: 209715200 } });
    expect(block?.container?.cpu?.limit_cores).toBe(1);
    expect(block?.capabilities).toEqual(expect.arrayContaining(["process.cpu", "process.memory", "container.cpu", "container.memory", "runtime.node"]));
    expect(validate(block, spec.components.schemas.Resources)).toEqual([]);
    for (const path of paths(block)) {
      expect(goldenSet.has(path), path).toBe(true);
    }
  });

  it("the client's heartbeat carries identity and resources that validate", async () => {
    process.env.APILENS_SEND_HEARTBEAT = "true";
    try {
      const client = new ApiLensClient({
        apiKey: "k",
        baseUrl: "http://ingest.test/v1",
        fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
        logger: SILENT,
      });
      client.stop();
      const body = client.heartbeatPayload();
      expect(body.identity).toMatchObject({ platform: expect.any(String), process_start_time: expect.stringMatching(/Z$/) });
      expect(body.resources).toMatchObject({ v: 1, n: 1, capabilities: expect.arrayContaining(["process.cpu", "process.memory", "runtime.node"]) });
      expect(validate(body, requestSchema("/v1/heartbeat"))).toEqual([]);
      for (const path of paths(body.resources)) {
        expect(goldenSet.has(path), path).toBe(true);
      }
      await client.handleShutdown({ flush: false });
    } finally {
      process.env.APILENS_SEND_HEARTBEAT = "false";
    }
  });

  it("captureResources: false sends identity but no resources", async () => {
    process.env.APILENS_SEND_HEARTBEAT = "true";
    try {
      const client = new ApiLensClient({
        apiKey: "k",
        captureResources: false,
        fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
        logger: SILENT,
      });
      client.stop();
      const body = client.heartbeatPayload();
      expect(body).not.toHaveProperty("resources");
      expect(client.resources.mode).toBe("off");
      expect(body.identity).toMatchObject({ platform: expect.any(String), process_start_time: expect.stringMatching(/Z$/) });
      expect(validate(body, requestSchema("/v1/heartbeat"))).toEqual([]);
      await client.handleShutdown({ flush: false });
    } finally {
      process.env.APILENS_SEND_HEARTBEAT = "false";
    }
  });

  it("APILENS_CAPTURE_RESOURCES=false is the kill switch", async () => {
    process.env.APILENS_CAPTURE_RESOURCES = "false";
    try {
      const client = new ApiLensClient({ apiKey: "k", logger: SILENT, fetchImpl: (async () => new Response("{}")) as typeof fetch });
      expect(client.resources.mode).toBe("off");
      await client.handleShutdown({ flush: false });
    } finally {
      delete process.env.APILENS_CAPTURE_RESOURCES;
    }
  });

  it("the heartbeat response's policy.resources reaches the sampler", async () => {
    process.env.APILENS_SEND_HEARTBEAT = "true";
    try {
      const policy = {
        enabled: true, sample_rate: 1, capture_headers: true, capture_request_body: true,
        capture_response_body: true, max_payload_bytes: null,
        resources: { enabled: false, min_interval_s: 0, disabled_collectors: [] },
      };
      const client = new ApiLensClient({
        apiKey: "k",
        compress: false,
        logger: SILENT,
        fetchImpl: (async () => new Response(JSON.stringify({ policy }), { status: 200 })) as typeof fetch,
      });
      await vi.waitFor(() => expect(client.remotePolicy?.resources?.enabled).toBe(false));
      expect(client.heartbeatPayload()).not.toHaveProperty("resources");
      await client.handleShutdown({ flush: false });
    } finally {
      process.env.APILENS_SEND_HEARTBEAT = "false";
    }
  });
});

describe("edge runtimes", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await ApiLensClient.shutdown();
  });

  it("send capabilities: [] and nothing else", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const client = new ApiLensClient({
      apiKey: "k",
      flushMode: "inline",
      logger: SILENT,
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    });
    expect(client.resources.mode).toBe("edge");
    const body = client.heartbeatPayload();
    expect(body.resources).toEqual({ v: 1, capabilities: [], flags: [] });
    expect(body).not.toHaveProperty("identity");
    expect(validate(body, requestSchema("/v1/heartbeat"))).toEqual([]);
    await client.handleShutdown({ flush: false });
  });
});

describe("real processes", () => {
  let dir = "";
  let bundle = "";

  beforeAll(() => {
    // Bundle the SDK once (esbuild, as tsup does) so plain `node` can run it.
    const esbuild = createRequire(join(pkg, "node_modules/tsup/package.json"))("esbuild") as {
      buildSync: (options: Record<string, unknown>) => void;
    };
    dir = mkdtempSync(join(tmpdir(), "apilens-resources-"));
    bundle = join(dir, "sdk.mjs");
    esbuild.buildSync({
      entryPoints: [join(pkg, "src/index.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: bundle,
      logLevel: "silent",
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(source: string): { status: number | null; stdout: string; ms: number } {
    const script = join(dir, `script-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(script, source);
    const t0 = Date.now();
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, APILENS_SEND_HEARTBEAT: "true", APILENS_SEND_METADATA: "false" },
    });
    return { status: result.status, stdout: result.stdout, ms: Date.now() - t0 };
  }

  it("a script using the SDK exits by itself (every timer unref'd)", () => {
    const { status, stdout, ms } = run(`
      import { ApiLensClient } from ${JSON.stringify(bundle)};
      const client = new ApiLensClient({
        apiKey: "k",
        shutdownTimeoutMs: 200,
        fetchImpl: async () => new Response("{}", { status: 200 }),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      console.log(client.resources.mode);
    `);
    expect(stdout.trim()).toBe("node");
    expect(status).toBe(0);
    expect(ms).toBeLessThan(10_000);
  });

  it("a worker_threads worker does not start a second sampler", () => {
    const { status, stdout } = run(`
      import { Worker } from "node:worker_threads";
      import { ApiLensClient } from ${JSON.stringify(bundle)};
      const fetchImpl = async () => new Response("{}", { status: 200 });
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const client = new ApiLensClient({ apiKey: "k", fetchImpl, logger, shutdownTimeoutMs: 200 });
      console.log("main", client.resources.mode);
      const worker = new Worker(\`
        import(${JSON.stringify(bundle)}).then(async ({ ApiLensClient }) => {
          const c = new ApiLensClient({ apiKey: "k", fetchImpl: async () => new Response("{}"), logger: { debug() {}, warn() {} } });
          const body = c.heartbeatPayload();
          console.log("worker", c.resources.mode, "resources" in body, "identity" in body);
          await c.handleShutdown({ flush: false });
          const off = new ApiLensClient({ apiKey: "k", captureResources: false, fetchImpl: async () => new Response("{}"), logger: { debug() {}, warn() {} } });
          const offBody = off.heartbeatPayload();
          console.log("worker-off", off.resources.mode, "resources" in offBody, "identity" in offBody);
          await off.handleShutdown({ flush: false });
        });
      \`, { eval: true });
      worker.on("exit", () => client.handleShutdown({ flush: false }));
    `);
    expect(status).toBe(0);
    expect(stdout).toContain("main node");
    expect(stdout).toContain("worker off false false");
    expect(stdout).toContain("worker-off off false false");
  });
});
