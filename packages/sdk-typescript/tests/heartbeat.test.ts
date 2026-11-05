/**
 * Heartbeat: POST /v1/heartbeat on start, every interval and on shutdown
 * (issue #547; contract: apps/docs/ingest/heartbeat.mdx and the Heartbeat /
 * HeartbeatAccepted schemas of api/openapi/apilens.v1.json).
 */
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient, SDK_NAME, SDK_VERSION } from "../src/client.js";
import { CAPTURE_EVERYTHING } from "../src/policy.js";
import type { ApiLensClientConfig, Logger } from "../src/types.js";
import { hasApiKeyField, requestSchema, responseSchema, validate } from "./contract.js";

const API_KEY = "apilens_test_HEARTBEATKEY";

const POLICY = {
  enabled: true,
  sample_rate: 0.5,
  capture_headers: false,
  capture_request_body: true,
  capture_response_body: false,
  max_payload_bytes: 1024,
};

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type Reply = { status: number; body?: string; headers?: Record<string, string> };

function ok(policy: Record<string, unknown> = POLICY): Reply {
  return { status: 200, body: JSON.stringify({ policy }), headers: { "content-type": "application/json" } };
}

/** Fake ingest: heartbeats answer the next scripted reply (the last one repeats); anything else 202. */
function fakeIngest(...replies: Reply[]) {
  const sent: Sent[] = [];
  const script = replies.length > 0 ? replies : [ok()];
  let beats = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const raw = init?.body as string | Uint8Array;
    const text = headers["content-encoding"] === "gzip"
      ? gunzipSync(raw as Uint8Array).toString("utf8")
      : String(raw);
    sent.push({ url: String(url), headers, body: JSON.parse(text) });
    if (!String(url).endsWith("/heartbeat")) {
      return new Response("{}", { status: 202 });
    }
    const reply = script[Math.min(beats, script.length - 1)];
    beats += 1;
    return new Response(reply.body ?? null, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  return {
    fetchImpl,
    sent,
    heartbeats: () => sent.filter((s) => s.url.endsWith("/heartbeat")),
  };
}

function makeClient(fetchImpl: typeof fetch, overrides: ApiLensClientConfig = {}): ApiLensClient {
  return new ApiLensClient({
    apiKey: API_KEY,
    baseUrl: "http://ingest.test/v1",
    appId: "storefront",
    environment: "staging",
    release: "2026.11.05",
    commit: "9f2c1ab",
    compress: false,
    fetchImpl,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  });
}

beforeEach(() => {
  process.env.APILENS_SEND_HEARTBEAT = "true";
});

afterEach(async () => {
  vi.useRealTimers();
  await ApiLensClient.shutdown();
  process.env.APILENS_SEND_HEARTBEAT = "false";
});

describe("heartbeat contract", () => {
  it("is sent on start with the fields of the ingest Heartbeat schema", async () => {
    const ingest = fakeIngest();
    const client = makeClient(ingest.fetchImpl, { projectSlug: "shop" });
    await vi.waitFor(() => expect(ingest.heartbeats()).toHaveLength(1));

    const { url, headers, body } = ingest.heartbeats()[0];
    expect(url).toBe("http://ingest.test/v1/heartbeat");
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(validate(body, requestSchema("/v1/heartbeat"))).toEqual([]);
    expect(hasApiKeyField(body)).toBe(false);
    expect(body).toMatchObject({
      app_id: "storefront",
      environment: "staging",
      project_slug: "shop",
      instance_id: client.instanceId,
      sdk_name: SDK_NAME,
      sdk_version: SDK_VERSION,
      runtime: `node ${process.versions.node}`,
      release: "2026.11.05",
      commit: "9f2c1ab",
      pid: process.pid,
    });
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(body).not.toHaveProperty("final");
    expect(Object.keys(body.stats as object)).toEqual(expect.arrayContaining([
      "queued_records", "sent_records", "dropped", "drop_counts", "last_error",
    ]));
    // Within the edge's limits.
    expect(Buffer.byteLength(JSON.stringify(body.stats))).toBeLessThanOrEqual(16 << 10);
  });

  it("is gzip encoded like every ingest body when compress is on", async () => {
    const ingest = fakeIngest();
    makeClient(ingest.fetchImpl, { compress: true });
    await vi.waitFor(() => expect(ingest.heartbeats()).toHaveLength(1));
    expect(ingest.heartbeats()[0].headers["content-encoding"]).toBe("gzip");
    expect(ingest.heartbeats()[0].body.app_id).toBe("storefront");
  });

  it("keeps the policy of a documented 200 response", async () => {
    const response = { policy: POLICY };
    expect(validate(response, responseSchema("/v1/heartbeat", "200"))).toEqual([]);

    const ingest = fakeIngest(ok());
    const client = makeClient(ingest.fetchImpl);
    expect(client.remotePolicy).toBeNull();
    await vi.waitFor(() => expect(client.remotePolicy).not.toBeNull());
    expect(client.remotePolicy).toEqual({
      enabled: true,
      sampleRate: 0.5,
      captureHeaders: false,
      captureRequestBody: true,
      captureResponseBody: false,
      maxPayloadBytes: 1024,
    });
  });

  it("parses the documented capture-everything answer", async () => {
    const everything = {
      enabled: true, sample_rate: 1, capture_headers: true,
      capture_request_body: true, capture_response_body: true, max_payload_bytes: null,
    };
    expect(validate({ policy: everything }, responseSchema("/v1/heartbeat", "200"))).toEqual([]);
    const ingest = fakeIngest(ok(everything));
    const client = makeClient(ingest.fetchImpl);
    await vi.waitFor(() => expect(client.remotePolicy).toEqual({ ...CAPTURE_EVERYTHING }));
  });

  it("repeats every interval with one instance id", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const ingest = fakeIngest();
    makeClient(ingest.fetchImpl, { heartbeatIntervalMs: 60_000 });

    await vi.advanceTimersByTimeAsync(1);
    expect(ingest.heartbeats()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ingest.heartbeats()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ingest.heartbeats()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ingest.heartbeats()).toHaveLength(3);

    const ids = new Set(ingest.heartbeats().map((h) => h.body.instance_id));
    expect(ids.size).toBe(1);
  });

  it("waits Retry-After after a 429 and keeps the previous policy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const ingest = fakeIngest(
      ok(),
      { status: 429, body: '{"error":"rate_limited"}', headers: { "retry-after": "12" } },
      ok({ ...POLICY, sample_rate: 0.25 }),
    );
    const client = makeClient(ingest.fetchImpl, { heartbeatIntervalMs: 10_000 });

    await vi.advanceTimersByTimeAsync(1);
    expect(client.remotePolicy?.sampleRate).toBe(0.5);
    await vi.advanceTimersByTimeAsync(10_000); // the 429
    expect(ingest.heartbeats()).toHaveLength(2);
    expect(client.remotePolicy?.sampleRate).toBe(0.5);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(ingest.heartbeats()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ingest.heartbeats()).toHaveLength(3);
    expect(client.remotePolicy?.sampleRate).toBe(0.25);
  });

  it("keeps the previous policy on 503 and on a body without a policy", async () => {
    const ingest = fakeIngest(
      ok(),
      { status: 503, body: '{"error":"unavailable"}', headers: { "retry-after": "1" } },
      { status: 200, body: "not json" },
      { status: 200, body: '{"accepted":1}' },
    );
    const client = makeClient(ingest.fetchImpl);
    await vi.waitFor(() => expect(client.remotePolicy).not.toBeNull());
    const before = client.remotePolicy;

    expect(await client.sendHeartbeat()).toBe(false); // 503
    expect(client.remotePolicy).toEqual(before);
    expect(await client.sendHeartbeat()).toBe(true); // non-JSON 200
    expect(client.remotePolicy).toEqual(before);
    expect(await client.sendHeartbeat()).toBe(true); // 200 without policy
    expect(client.remotePolicy).toEqual(before);
  });

  it("logs a 401/403/422 rejection once", async () => {
    const warnings: unknown[][] = [];
    const logger: Logger = { debug() {}, warn: (...args) => warnings.push(args) };
    const ingest = fakeIngest({ status: 422, body: '{"error":"validation_error","detail":"unknown app"}' });
    const client = makeClient(ingest.fetchImpl, { logger });
    client.stop();

    await client.sendHeartbeat();
    await client.sendHeartbeat();
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain("422");
    expect(String(warnings[0][1])).toContain("unknown app");
  });

  it("never throws on a network error", async () => {
    const client = makeClient((async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    client.stop();
    await expect(client.sendHeartbeat()).resolves.toBe(false);
  });

  it("sends a final heartbeat on shutdown", async () => {
    const ingest = fakeIngest();
    makeClient(ingest.fetchImpl);
    await vi.waitFor(() => expect(ingest.heartbeats()).toHaveLength(1));

    await ApiLensClient.shutdown();
    const beats = ingest.heartbeats();
    expect(beats).toHaveLength(2);
    expect(beats[1].body.final).toBe(true);
    expect(validate(beats[1].body, requestSchema("/v1/heartbeat"))).toEqual([]);
  });

  it("sends one heartbeat per registered app and environment", async () => {
    const ingest = fakeIngest();
    const client = makeClient(ingest.fetchImpl);
    client.stop();
    client.registerApp("storefront", "staging"); // the client's own: no-op
    client.registerApp("storefront", "canary");
    await client.sendHeartbeat();
    const envs = ingest.heartbeats().map((h) => h.body.environment).sort();
    expect(envs).toEqual(["canary", "staging"]);
  });

  it.each([
    ["sendHeartbeat: false", { sendHeartbeat: false }, "true"],
    ["APILENS_SEND_HEARTBEAT=false", {}, "false"],
    ["APILENS_SEND_HEARTBEAT=0", {}, "0"],
  ])("is off with %s", async (_name, overrides, env) => {
    process.env.APILENS_SEND_HEARTBEAT = env;
    const ingest = fakeIngest();
    const client = makeClient(ingest.fetchImpl, overrides);
    expect(await client.sendHeartbeat()).toBe(false);
    await ApiLensClient.shutdown();
    expect(ingest.heartbeats()).toHaveLength(0);
  });

  it("is not sent by a disabled client", async () => {
    const ingest = fakeIngest();
    makeClient(ingest.fetchImpl, { enabled: false });
    await new Promise((r) => setTimeout(r, 20));
    await ApiLensClient.shutdown();
    expect(ingest.heartbeats()).toHaveLength(0);
  });

  it("refuses an interval below the ingest rate limit", () => {
    expect(() => makeClient(fakeIngest().fetchImpl, { heartbeatIntervalMs: 5_000 })).toThrow(/heartbeatIntervalMs/);
  });

  it("does not delay or block data delivery when it fails", async () => {
    const ingest = fakeIngest({ status: 500 });
    const client = makeClient(ingest.fetchImpl);
    client.stop();
    client.capture({ method: "GET", path: "/a", status_code: 200, response_time_ms: 1 });
    await client.sendHeartbeat();
    expect(await client.flushAll()).toBe(1);
    expect(client.stats().droppedCount).toBe(0);
  });
});
