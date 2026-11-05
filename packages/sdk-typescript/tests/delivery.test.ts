/**
 * Delivery safety (issue #546): byte-bounded queue, maxBatchBytes, gzip,
 * retry classification with Retry-After and jitter, drop reasons, stats().
 * Ports packages/sdk-python/tests/test_queue_bounds.py with a fake fetch.
 */
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApiLensClient,
  RECORD_OVERHEAD_BYTES,
  estimateRecordBytes,
  normalizeRecord,
  parseRetryAfter,
} from "../src/client.js";
import type { ApiLensClientConfig, ApiLensClientStats, ApiLensRecord } from "../src/types.js";

const KB = 1024;
const MB = 1024 * KB;

type Call = { url: string; headers: Record<string, string>; body: string; rawBytes: number };

afterEach(async () => {
  await ApiLensClient.shutdown();
});

function decode(body: unknown, headers: Record<string, string>): { text: string; rawBytes: number } {
  if (typeof body === "string") {
    return { text: body, rawBytes: Buffer.byteLength(body) };
  }
  const bytes = Buffer.from(body as Uint8Array);
  if (headers["Content-Encoding"] === "gzip") {
    return { text: gunzipSync(bytes).toString("utf8"), rawBytes: bytes.length };
  }
  return { text: bytes.toString("utf8"), rawBytes: bytes.length };
}

function makeClient(
  overrides: ApiLensClientConfig = {},
  respond: (attempt: number) => Response | Promise<Response> = () => new Response(null, { status: 202 }),
): { client: ApiLensClient; calls: Call[]; sleeps: number[]; logs: Array<[string, unknown[]]> } {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: Array<[string, unknown[]]> = [];
  const log = (level: string) => (...args: unknown[]) => {
    logs.push([level, args]);
  };
  const client = new ApiLensClient({
    apiKey: "test-key",
    appId: "app",
    maxRetries: 0,
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    fetchImpl: async (url, init) => {
      const headers = (init?.headers || {}) as Record<string, string>;
      const { text, rawBytes } = decode(init?.body, headers);
      calls.push({ url: String(url), headers, body: text, rawBytes });
      return respond(calls.length);
    },
    ...overrides,
  });
  client.stop();
  client.sleepFn = async (ms: number) => {
    sleeps.push(ms);
  };
  return { client, calls, sleeps, logs };
}

function record(payload = "", path = "/r"): ApiLensRecord {
  return normalizeRecord(
    { method: "GET", path, status_code: 200, response_time_ms: 1, request_payload: payload },
    "test",
    "",
    "app",
  );
}

describe("byte-bounded queue", () => {
  it("estimates strings plus a fixed overhead", () => {
    const rec = record("x".repeat(1000), "/abc");
    rec.response_headers = "h".repeat(10);
    expect(estimateRecordBytes(rec)).toBe(RECORD_OVERHEAD_BYTES + 1000 + 10 + 4 + 4);
  });

  it("has safe defaults", () => {
    const { client } = makeClient();
    expect(client.config.maxQueueBytes).toBe(64 * MB);
    expect(client.config.maxBatchBytes).toBe(4 * MB);
    expect(client.config.compress).toBe(true);
  });

  it("keeps memory under maxQueueBytes with 10k x 64 KB records", () => {
    const maxBytes = 8 * MB;
    const { client } = makeClient({ maxQueueBytes: maxBytes, batchSize: 1_000_000 });
    const n = 10_000;
    const recordBytes = estimateRecordBytes(record("x".repeat(64 * KB)));

    const before = process.memoryUsage().heapUsed;
    let peak = before;
    for (let i = 0; i < n; i += 1) {
      // Buffer-backed strings are flat (not shared rope nodes), so the
      // retained memory is real.
      client.captureRecord(record(Buffer.alloc(64 * KB, String(i % 10)).toString()));
      expect(client.queuedBytes).toBeLessThanOrEqual(maxBytes);
      if (i % 500 === 0) {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }
    }
    peak = Math.max(peak, process.memoryUsage().heapUsed);

    // Unbounded this would retain ~640 MB; the queue holds at most 8 MB.
    expect(peak - before).toBeLessThan(160 * MB);

    const kept = client.queue.length;
    expect(kept).toBe(Math.floor(maxBytes / recordBytes));
    const counts = client.dropCounts();
    expect(counts.queue_bytes).toBe(n - kept);
    expect(counts.queue_full).toBe(0);
    expect(client.droppedCount).toBe(n - kept);
    // Drop-oldest: the newest record is still queued.
    expect(client.queue[kept - 1].request_payload[0]).toBe(String((n - 1) % 10));
  });

  it("still applies maxQueueSize and counts queue_full", () => {
    const { client } = makeClient({ maxQueueSize: 3, batchSize: 100 });
    for (let i = 0; i < 5; i += 1) {
      client.captureRecord(record("", `/${i}`));
    }
    expect(client.queue.map((r) => r.path)).toEqual(["/2", "/3", "/4"]);
    expect(client.dropCounts().queue_full).toBe(2);
    expect(client.droppedCount).toBe(2);
  });

  it("drops a single oversized record without evicting", () => {
    const { client } = makeClient({ maxQueueBytes: 4 * KB, batchSize: 100 });
    client.captureRecord(record("a"));
    client.captureRecord(record("b".repeat(8 * KB)));
    expect(client.queue).toHaveLength(1);
    expect(client.dropCounts().queue_bytes).toBe(1);
  });

  it("releases bytes when batches are sent", async () => {
    const { client } = makeClient({ batchSize: 100 });
    client.captureRecord(record("x".repeat(100)));
    expect(client.queuedBytes).toBeGreaterThan(0);
    await client.flushAll();
    expect(client.queuedBytes).toBe(0);
  });
});

describe("maxBatchBytes", () => {
  it("never sends a body larger than maxBatchBytes", async () => {
    const limit = 256 * KB;
    const { client, calls } = makeClient({ maxBatchBytes: limit, batchSize: 200, compress: false });
    for (let i = 0; i < 50; i += 1) {
      client.captureRecord(record("p".repeat(40 * KB), `/${i}`));
    }
    const sent = await client.flushAll();

    expect(sent).toBe(50);
    expect(calls.length).toBeGreaterThan(1);
    let total = 0;
    for (const call of calls) {
      expect(Buffer.byteLength(call.body)).toBeLessThanOrEqual(limit);
      total += JSON.parse(call.body).requests.length;
    }
    expect(total).toBe(50);
    expect(client.dropCounts().truncated).toBe(0);
  });

  it("truncates an oversized single record, payloads first", async () => {
    const limit = 64 * KB;
    const { client, calls } = makeClient({ maxBatchBytes: limit, compress: false });
    const big = record("q".repeat(200 * KB));
    big.response_payload = "s".repeat(200 * KB);
    big.request_headers = '{"accept":"*/*"}';
    client.captureRecord(big);
    client.captureRecord(record("small"));

    await client.flushAll();

    expect(calls).toHaveLength(2);
    expect(Buffer.byteLength(calls[0].body)).toBeLessThanOrEqual(limit);
    const sentRecord = JSON.parse(calls[0].body).requests[0];
    expect(sentRecord.response_payload).toBe("");
    expect(sentRecord.request_payload.length).toBeGreaterThan(0);
    expect(sentRecord.request_headers).toBe('{"accept":"*/*"}');
    expect(client.dropCounts().truncated).toBe(1);
    // Truncated records were delivered, so they are not drops.
    expect(client.droppedCount).toBe(0);
    expect(JSON.parse(calls[1].body).requests[0].request_payload).toBe("small");
  });

  it("stays under the limit with multi-byte and escaped characters", async () => {
    const limit = 8 * KB;
    const { client, calls } = makeClient({ maxBatchBytes: limit, compress: false });
    client.captureRecord(record("é\"\n😀".repeat(4 * KB)));
    await client.flushAll();
    expect(calls).toHaveLength(1);
    expect(Buffer.byteLength(calls[0].body)).toBeLessThanOrEqual(limit);
  });
});

describe("gzip", () => {
  it("gzips bodies by default with Content-Encoding: gzip", async () => {
    const { client, calls } = makeClient();
    client.captureRecord(record("z".repeat(10 * KB)));
    await client.flushAll();

    expect(calls[0].headers["Content-Encoding"]).toBe("gzip");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].rawBytes).toBeLessThan(Buffer.byteLength(calls[0].body));
    expect(JSON.parse(calls[0].body).requests[0].request_payload).toHaveLength(10 * KB);
  });

  it("compress: false sends plain JSON", async () => {
    const { client, calls } = makeClient({ compress: false });
    client.captureRecord(record("plain"));
    await client.flushAll();
    expect(calls[0].headers["Content-Encoding"]).toBeUndefined();
    expect(JSON.parse(calls[0].body).requests[0].request_payload).toBe("plain");
  });
});

describe("retry policy", () => {
  it.each([400, 401, 403, 413, 422])("does not retry %i and counts non_retryable", async (status) => {
    const { client, calls } = makeClient(
      { maxRetries: 3 },
      () => new Response("nope", { status }),
    );
    client.captureRecord(record());
    client.captureRecord(record());
    await client.flushOnce();
    expect(calls).toHaveLength(1);
    expect(client.dropCounts().non_retryable).toBe(2);
    expect(client.droppedCount).toBe(2);
  });

  it("logs one clear 401 message pointing at troubleshooting, once per window", async () => {
    const { client, logs } = makeClient({}, () => new Response("bad key", { status: 401 }));
    client.captureRecord(record());
    await client.flushOnce();
    client.captureRecord(record());
    await client.flushOnce();

    const errors = logs.filter(([level]) => level === "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0][1][0])).toMatch(/401/);
    expect(String(errors[0][1][0])).toMatch(/docs\/support\/troubleshooting/);
  });

  it("logs a 422 response body once per status", async () => {
    const { client, logs } = makeClient({}, () => new Response("field x invalid", { status: 422 }));
    for (let i = 0; i < 3; i += 1) {
      client.captureRecord(record());
      await client.flushOnce();
    }
    const rejected = logs.filter(
      ([level, args]) => level === "warn" && String(args[0]).includes("status 422"),
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0][1][1]).toBe("field x invalid");
  });

  it("retries 503 then counts retries_exhausted", async () => {
    const { client, calls, sleeps } = makeClient(
      { maxRetries: 2 },
      () => new Response(null, { status: 503 }),
    );
    client.captureRecord(record());
    await client.flushOnce();
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(client.dropCounts()).toEqual({
      queue_full: 0,
      queue_bytes: 0,
      non_retryable: 0,
      retries_exhausted: 1,
      truncated: 0,
    });
  });

  it("retries 408 and recovers", async () => {
    const { client, calls } = makeClient(
      { maxRetries: 2 },
      (attempt) => new Response(null, { status: attempt === 1 ? 408 : 202 }),
    );
    client.captureRecord(record());
    expect(await client.flushOnce()).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("honours Retry-After seconds on 429", async () => {
    const { client, calls, sleeps } = makeClient(
      { maxRetries: 2 },
      (attempt) => attempt === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "7" } })
        : new Response(null, { status: 202 }),
    );
    client.captureRecord(record());
    expect(await client.flushOnce()).toBe(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it("honours an HTTP-date Retry-After and caps it at 60 s", async () => {
    const now = Date.parse("2026-11-05T10:00:00Z");
    expect(parseRetryAfter("Thu, 05 Nov 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 05 Nov 2026 11:00:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("Thu, 05 Nov 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("3600")).toBe(60_000);
    expect(parseRetryAfter("1.5")).toBe(1500);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("retries a timeout as a network error", async () => {
    let attempts = 0;
    const client = new ApiLensClient({
      apiKey: "test-key",
      appId: "app",
      maxRetries: 1,
      timeoutMs: 20,
      logger: {},
      fetchImpl: (_url, init) => {
        attempts += 1;
        if (attempts === 2) {
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    client.stop();
    client.sleepFn = async () => {};
    client.captureRecord(record());
    expect(await client.flushOnce()).toBe(1);
    expect(attempts).toBe(2);
  });

  it("uses full-jitter backoff", () => {
    const { client } = makeClient({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 5000 });
    const samples = Array.from({ length: 100 }, () => client.backoffMs(3));
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(800);
    }
    // Spread: many distinct values across the window, not a fixed delay.
    expect(new Set(samples).size).toBeGreaterThan(50);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(400);
    // Capped by retryBackoffMaxMs.
    expect(client.backoffMs(20)).toBeLessThan(5000);
  });
});

describe("stats", () => {
  it("reports queued, sent, failed and drops, and calls onStats", async () => {
    const seen: ApiLensClientStats[] = [];
    let fail = false;
    const { client } = makeClient(
      { batchSize: 2, onStats: (s) => seen.push(s) },
      () => new Response(null, { status: fail ? 500 : 202 }),
    );

    expect(client.stats()).toMatchObject({
      queuedRecords: 0,
      queuedBytes: 0,
      sentBatches: 0,
      sentRecords: 0,
      failedBatches: 0,
      droppedCount: 0,
      lastError: null,
      lastSuccessAt: null,
    });

    client.config.batchSize = 10;
    client.captureRecord(record("a"));
    client.captureRecord(record("b"));
    client.captureRecord(record("c"));
    expect(client.stats().queuedRecords).toBe(3);
    expect(client.stats().queuedBytes).toBe(3 * estimateRecordBytes(record("a")));

    await client.flushAll();
    let stats = client.stats();
    expect(stats.sentBatches).toBe(1);
    expect(stats.sentRecords).toBe(3);
    expect(stats.queuedRecords).toBe(0);
    expect(stats.lastSuccessAt).not.toBeNull();

    fail = true;
    client.captureRecord(record("d"));
    await client.flushOnce();
    stats = client.stats();
    expect(stats.failedBatches).toBe(1);
    expect(stats.dropCounts.retries_exhausted).toBe(1);
    expect(stats.droppedCount).toBe(1);
    expect(stats.lastError).toMatch(/500/);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).toEqual(stats);
  });

  it("survives a throwing onStats callback", async () => {
    const { client } = makeClient({
      onStats: () => {
        throw new Error("exporter down");
      },
    });
    client.captureRecord(record());
    expect(await client.flushOnce()).toBe(1);
  });

  it("logs drops at info, rate limited", async () => {
    const { client, logs } = makeClient({ maxQueueSize: 1, batchSize: 100 });
    client.captureRecord(record());
    client.captureRecord(record());
    await client.flushOnce();
    client.captureRecord(record());
    client.captureRecord(record());
    await client.flushOnce();
    const infos = logs.filter(([level]) => level === "info");
    expect(infos).toHaveLength(1);
    expect(String(infos[0][1][0])).toMatch(/dropped 1 records/);
  });
});
