/**
 * Delivery without silent loss (issue #929, D2/D7 of #897): retry window,
 * drop reporting in the heartbeat, flush on process exit, byte accounting
 * for the span and log queues, oversize spans/logs truncated, partial accept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiLensClient,
  RECORD_OVERHEAD_BYTES,
  estimateSignalBytes,
  normalizeRecord,
  partialRejects,
  truncateSignalJson,
} from "../src/client.js";
import type {
  ApiLensClientConfig,
  ApiLensLogRecord,
  ApiLensRecord,
  ApiLensSpanRecord,
} from "../src/types.js";

const KB = 1024;

type Call = { path: string; body: Record<string, unknown> };

afterEach(async () => {
  await ApiLensClient.shutdown();
});

/**
 * A client on a fake clock: every retry sleep advances `now`, so a 300 s
 * window runs instantly. `respond(path, n)` answers the n-th call to `path`.
 */
function makeClient(
  overrides: ApiLensClientConfig = {},
  respond: (path: string, n: number, now: number) => Response = () => new Response(null, { status: 202 }),
) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const clock = { now: 1_000_000 };
  const client = new ApiLensClient({
    apiKey: "test-key",
    appId: "app",
    compress: false,
    logger: {},
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname.split("/").pop() ?? "";
      const n = (counts.get(path) ?? 0) + 1;
      counts.set(path, n);
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      return respond(path, n, clock.now);
    },
    ...overrides,
  });
  client.stop();
  client.nowFn = () => clock.now;
  client.sleepFn = async (ms: number) => {
    clock.now += ms;
  };
  const sent = (path: string) => calls.filter((c) => c.path === path);
  return { client, calls, clock, sent };
}

function record(path = "/r"): ApiLensRecord {
  return normalizeRecord(
    { method: "GET", path, status_code: 200, response_time_ms: 1 },
    "test",
    "",
    "app",
  );
}

function span(attributes: Record<string, string> = {}): ApiLensSpanRecord {
  return {
    timestamp: new Date().toISOString(),
    environment: "test",
    project_slug: "",
    app_id: "app",
    trace_id: "a".repeat(32),
    span_id: "b".repeat(16),
    parent_span_id: "",
    name: "GET /r",
    kind: "server",
    service_name: "app",
    duration_ms: 1,
    status: "ok",
    status_code: 200,
    attributes,
    release: "",
    commit: "",
  };
}

function log(payload = "", message = "boom"): ApiLensLogRecord {
  return {
    timestamp: new Date().toISOString(),
    environment: "test",
    project_slug: "",
    app_id: "app",
    level: "ERROR",
    message,
    logger_name: "apilens.exception",
    endpoint_method: "GET",
    endpoint_path: "/r",
    status_code: 500,
    consumer_id: "",
    consumer_name: "",
    consumer_group: "",
    trace_id: "a".repeat(32),
    span_id: "b".repeat(16),
    payload,
    attributes: { "exception.type": "Error", "exception.message": message },
    release: "",
    commit: "",
  };
}

describe("retry window", () => {
  it("loses nothing during a server outage shorter than maxRetrySeconds", async () => {
    // Ingest is down (503, then connection errors) for 4 minutes.
    let downUntil = 0;
    const { client, clock, sent } = makeClient({}, (_path, _n, now) => {
      if (now < downUntil) {
        if (now % 2 === 0) {
          throw new TypeError("fetch failed");
        }
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 202 });
    });
    downUntil = clock.now + 240_000;

    for (let i = 0; i < 5; i += 1) {
      client.captureRecord(record(`/r${i}`));
      client.captureSpan(span());
      client.captureLog(log("stack"));
    }
    await client.flushAll();

    expect(clock.now).toBeGreaterThanOrEqual(downUntil);
    expect(client.droppedCount).toBe(0);
    expect(client.stats().sentRecords).toBe(15);
    const delivered = (path: string, key: string) =>
      (sent(path).at(-1)?.body[key] ?? []) as unknown[]; // the attempt that succeeded
    expect(delivered("requests", "requests")).toHaveLength(5);
    expect(delivered("traces", "spans")).toHaveLength(5);
    expect(delivered("logs", "logs")).toHaveLength(5);
  });

  it("retries past the old three attempts by default", async () => {
    const { client, sent } = makeClient({}, (_p, n) => new Response(null, { status: n <= 10 ? 503 : 202 }));
    client.captureRecord(record());
    expect(await client.flushOnce()).toBe(1);
    expect(sent("requests")).toHaveLength(11);
  });

  it("drops a batch as retries_exhausted once the window has passed", async () => {
    const { client, clock } = makeClient(
      { maxRetrySeconds: 60 },
      () => new Response(null, { status: 503 }),
    );
    const start = clock.now;
    client.captureLog(log("x"));
    expect(await client.flushOnce()).toBe(0);
    expect(clock.now - start).toBeLessThanOrEqual(60_000);
    expect(clock.now - start).toBeGreaterThan(50_000);
    expect(client.signalDropCounts().logs).toEqual({ retries_exhausted: 1 });
  });

  it("runs one background flush at a time while a batch retries", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, sent } = makeClient(
      { batchSize: 1 },
      (_path, n) => new Response(null, { status: n === 1 ? 503 : 202 }),
    );
    client.sleepFn = () => gate;
    client.captureRecord(record("/a")); // starts a flush that waits to retry
    client.captureRecord(record("/b")); // a full batch again, but a flush is running
    client.captureRecord(record("/c"));
    expect(client.queue.map((r) => r.path)).toEqual(["/b", "/c"]);
    release();
    await client.flushAll();
    await vi.waitFor(() => expect(client.hasPending()).toBe(false));
    expect(client.droppedCount).toBe(0);
    const paths = sent("requests").flatMap((c) => (c.body.requests as ApiLensRecord[]).map((r) => r.path));
    expect(paths.sort()).toEqual(["/a", "/a", "/b", "/c"]); // /a twice: 503, then 202
  });
});

describe("partial accept", () => {
  it("counts records a 200 left out as server_rejected, not as a failure", async () => {
    const { client, sent } = makeClient({}, () =>
      new Response(
        JSON.stringify({ accepted: 2, invalid: 1, errors: [{ index: 1, reason: "bad timestamp" }] }),
        { status: 200 },
      ));
    client.captureRecord(record("/a"));
    client.captureRecord(record("/b"));
    client.captureRecord(record("/c"));
    expect(await client.flushOnce()).toBe(3);
    expect(sent("requests")).toHaveLength(1);
    const stats = client.stats();
    expect(stats.sentRecords).toBe(2);
    expect(stats.failedBatches).toBe(0);
    expect(stats.dropCounts.server_rejected).toBe(1);
    expect(client.signalDropCounts().requests).toEqual({ server_rejected: 1 });
  });

  it("reads rejected app entries", () => {
    expect(partialRejects(JSON.stringify({ accepted: 1, rejected: [{ records: 2 }, { records: 1 }] }), 5)).toBe(3);
    expect(partialRejects(JSON.stringify({ accepted: 3 }), 3)).toBe(0);
    expect(partialRejects("", 3)).toBe(0);
    expect(partialRejects("not json", 3)).toBe(0);
    expect(partialRejects(JSON.stringify({ invalid: 9 }), 3)).toBe(3);
  });
});

describe("span and log queues", () => {
  it("are bounded by maxQueueBytes, dropping the oldest", () => {
    const { client } = makeClient({ maxQueueBytes: 3 * (RECORD_OVERHEAD_BYTES + 2 * KB), batchSize: 1000 });
    const item = log("p".repeat(KB), "m0");
    const size = estimateSignalBytes(item);
    for (let i = 0; i < 5; i += 1) {
      client.captureLog(log("p".repeat(KB), `m${i}`.padEnd(2, " ")));
    }
    const kept = Math.floor((3 * (RECORD_OVERHEAD_BYTES + 2 * KB)) / size);
    expect(client.logQueue).toHaveLength(kept);
    expect(client.logQueue[client.logQueue.length - 1].message).toBe("m4");
    expect(client.queuedLogBytes).toBe(kept * size);
    expect(client.signalDropCounts().logs).toEqual({ queue_bytes: 5 - kept });
    expect(client.stats().queuedLogBytes).toBe(kept * size);
  });

  it("frees the bytes when items are sent", async () => {
    const { client } = makeClient();
    client.captureSpan(span({ "http.url": "x".repeat(100) }));
    expect(client.queuedSpanBytes).toBeGreaterThan(RECORD_OVERHEAD_BYTES + 100);
    await client.flushAll();
    expect(client.queuedSpanBytes).toBe(0);
  });

  it("truncates an oversize log (payload head and tail kept) instead of dropping it", async () => {
    const { client, sent } = makeClient({ maxBatchBytes: 4 * KB });
    const payload = `Error: top of the stack\n${"x".repeat(20 * KB)}\nCaused by: RootCause: the database is gone`;
    client.captureLog(log(payload));
    expect(await client.flushAll()).toBe(1);

    const body = sent("logs")[0].body as { logs: ApiLensLogRecord[] };
    const shipped = body.logs[0];
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(4 * KB);
    expect(shipped.payload.startsWith("Error: top of the stack")).toBe(true);
    expect(shipped.payload.endsWith("RootCause: the database is gone")).toBe(true);
    expect(shipped.payload).toMatch(/…\[\d+ chars truncated\]…/);
    expect(shipped.message).toBe("boom");
    expect(client.dropCounts().truncated).toBe(1);
    expect(client.droppedCount).toBe(0);
  });

  it("truncates an oversize span's attributes instead of dropping it", async () => {
    const { client, sent } = makeClient({ maxBatchBytes: 2 * KB });
    client.captureSpan(span({ "db.statement": "s".repeat(10 * KB), "http.route": "/r" }));
    expect(await client.flushAll()).toBe(1);
    const shipped = (sent("traces")[0].body as { spans: ApiLensSpanRecord[] }).spans[0];
    expect(shipped.attributes["http.route"]).toBe("/r");
    expect(shipped.attributes["db.statement"].length).toBeLessThan(2 * KB);
    expect(client.signalDropCounts().spans).toEqual({ truncated: 1 });
  });

  it("truncateSignalJson falls back to message, then attributes, and gives up when nothing is left", () => {
    const item = log("", "m".repeat(5000));
    const json = truncateSignalJson(item, 1500);
    expect(json).toBeDefined();
    expect(Buffer.byteLength(json as string)).toBeLessThanOrEqual(1500);
    expect(truncateSignalJson(log("x"), 10)).toBeUndefined();
  });
});

describe("drop reporting", () => {
  const savedEnv = process.env.APILENS_SEND_HEARTBEAT;
  beforeEach(() => {
    process.env.APILENS_SEND_HEARTBEAT = "true";
  });
  afterEach(() => {
    process.env.APILENS_SEND_HEARTBEAT = savedEnv;
  });

  it("sends drops since the last accepted heartbeat, per signal and reason", async () => {
    let beat = 0;
    const { client, sent } = makeClient(
      { maxQueueSize: 1, batchSize: 100, sendHeartbeat: true },
      (path) => {
        if (path === "heartbeat") {
          beat += 1;
          // The second heartbeat fails: its drops are sent again next time.
          return new Response("{}", { status: beat === 2 ? 503 : 200 });
        }
        return new Response(null, { status: 400 });
      },
    );
    client.captureSpan(span());
    client.captureSpan(span()); // queue_full
    client.captureRecord(record());
    await client.flushOnce(); // 400: 1 request and 1 span non_retryable
    client.captureRecord(record());
    client.captureRecord(record()); // queue_full
    client.captureRecord({ ...record(), request_payload: "x".repeat(2 * KB) });
    client.config.maxQueueBytes = 1; // the next one cannot fit at all
    client.captureRecord(record());

    await client.sendHeartbeat();
    const first = sent("heartbeat")[0].body;
    expect(first.dropped).toEqual({
      requests: { non_retryable: 1, queue_full: 2, queue_bytes: 1 },
      spans: { queue_full: 1, non_retryable: 1 },
      logs: {},
    });

    client.captureLog(log());
    client.config.maxQueueBytes = 1;
    client.captureLog(log()); // queue_bytes
    await client.sendHeartbeat(); // 503
    await client.sendHeartbeat(); // 200
    const [, second, third] = sent("heartbeat").map((h) => h.body);
    expect(second.dropped).toEqual({ requests: {}, spans: {}, logs: { queue_bytes: 2 } });
    expect(third.dropped).toEqual(second.dropped);

    await client.sendHeartbeat();
    expect(sent("heartbeat")[3].body.dropped).toBeUndefined();
  });

  it("does not report truncated or server_rejected records", async () => {
    const { client, sent } = makeClient(
      { sendHeartbeat: true, maxBatchBytes: 2 * KB },
      (path) => path === "heartbeat"
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ accepted: 0, invalid: 1 }), { status: 200 }),
    );
    client.captureLog(log("z".repeat(8 * KB)));
    await client.flushAll();
    expect(client.dropCounts().truncated).toBe(1);
    expect(client.dropCounts().server_rejected).toBe(1);
    await client.sendHeartbeat();
    expect(sent("heartbeat")[0].body.dropped).toBeUndefined();
  });
});

describe("shutdown", () => {
  it("stops retrying at shutdownTimeoutMs and reports the drops in the final heartbeat", async () => {
    const savedEnv = process.env.APILENS_SEND_HEARTBEAT;
    process.env.APILENS_SEND_HEARTBEAT = "true";
    try {
      const { client, clock, sent } = makeClient(
        { shutdownTimeoutMs: 5000, batchSize: 1, sendHeartbeat: true },
        (path) => path === "heartbeat"
          ? new Response("{}", { status: 200 })
          : new Response(null, { status: 503 }),
      );
      (client as unknown as { heartbeatsStarted: boolean }).heartbeatsStarted = true;
      const start = clock.now;
      client.captureRecord(record("/a"));
      client.captureRecord(record("/b"));
      client.captureLog(log());
      await client.handleShutdown();

      // Not the 300 s retry window: the shutdown deadline wins.
      expect(clock.now - start).toBeLessThanOrEqual(5000);
      expect(client.hasPending()).toBe(false);
      const final = sent("heartbeat").at(-1)?.body;
      expect(final?.final).toBe(true);
      expect(final?.dropped).toEqual({
        requests: { retries_exhausted: 2 },
        spans: {},
        logs: { retries_exhausted: 1 },
      });
    } finally {
      process.env.APILENS_SEND_HEARTBEAT = savedEnv;
    }
  });

  it("returns after shutdownTimeoutMs when ingest hangs, counting what is still queued", async () => {
    const client = new ApiLensClient({
      apiKey: "test-key",
      appId: "app",
      logger: {},
      batchSize: 1,
      shutdownTimeoutMs: 50,
      fetchImpl: () => new Promise<Response>(() => undefined), // never answers
    });
    client.stop();
    client.captureRecord(record("/a")); // in flight
    client.captureRecord(record("/b"));
    client.captureRecord(record("/c"));
    const started = Date.now();
    await client.handleShutdown();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.signalDropCounts().requests).toEqual({ shutdown: 1 });
    expect(client.queue).toHaveLength(0);
  });
});

describe("exit flush", () => {
  function background(overrides: ApiLensClientConfig = {}) {
    const bodies: string[] = [];
    const client = new ApiLensClient({
      apiKey: "test-key",
      appId: "app",
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

  /** Run `fn` with only the SDK's own listener for `event`, then restore the others. */
  async function alone(event: string, fn: () => Promise<void>): Promise<void> {
    const others = process.listeners(event as NodeJS.Signals).filter((l) => !String(l).includes("handleShutdown"));
    for (const l of others) {
      process.removeListener(event, l);
    }
    try {
      await fn();
    } finally {
      for (const l of others) {
        process.on(event, l);
      }
    }
  }

  it("flushes pending data on SIGTERM and raises the signal again", async () => {
    const { client, bodies } = background();
    client.captureRecord(record("/term"));
    client.captureLog(log("stack"));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await alone("SIGTERM", async () => {
        expect(process.listenerCount("SIGTERM")).toBe(1);
        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"));
      });
      expect(bodies.some((b) => b.includes("/requests") && b.includes("/term"))).toBe(true);
      expect(bodies.some((b) => b.includes("/logs") && b.includes("stack"))).toBe(true);
      expect(ApiLensClient.current()).toBeUndefined();
    } finally {
      kill.mockRestore();
    }
  });

  it("leaves the exit to the app's own SIGINT listener", async () => {
    const { client, bodies } = background();
    client.captureRecord(record("/int"));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const appListener = vi.fn();
    try {
      await alone("SIGINT", async () => {
        process.on("SIGINT", appListener);
        process.emit("SIGINT", "SIGINT");
        await vi.waitFor(() => expect(bodies.some((b) => b.includes("/int"))).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 10));
        process.removeListener("SIGINT", appListener);
      });
      expect(appListener).toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("flushes pending data on beforeExit", async () => {
    const { client, bodies } = background();
    client.captureSpan(span({ "http.route": "/exit" }));
    process.emit("beforeExit", 0);
    await vi.waitFor(() => expect(bodies.some((b) => b.includes("/traces") && b.includes("/exit"))).toBe(true));
    expect(ApiLensClient.current()).toBeUndefined();
  });

  it("does nothing on exit with flushOnShutdown: false", async () => {
    const { client, bodies } = background({ flushOnShutdown: false });
    client.captureRecord(record("/kept"));
    process.emit("beforeExit", 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bodies).toEqual([]);
    expect(ApiLensClient.current()).toBe(client);
  });
});
