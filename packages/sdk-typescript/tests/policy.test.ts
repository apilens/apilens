/**
 * Remote capture policy (issue #547): it only ever narrows what the SDK
 * captures. A local setting that captures less always wins.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiLensClient, normalizeRecord } from "../src/client.js";
import { createApiLensMiddleware } from "../src/express.js";
import {
  CAPTURE_EVERYTHING,
  applyRemotePolicy,
  narrowPayloadBytes,
  parseRemotePolicy,
  type RemotePolicy,
} from "../src/policy.js";
import type { ApiLensExpressConfig, ApiLensRecord } from "../src/types.js";

const EVERYTHING_WIRE = {
  enabled: true,
  sample_rate: 1,
  capture_headers: true,
  capture_request_body: true,
  capture_response_body: true,
  max_payload_bytes: 1 << 20,
};

function record(overrides: Partial<ApiLensRecord> = {}): ApiLensRecord {
  return {
    ...normalizeRecord(
      {
        method: "POST",
        path: "/orders",
        status_code: 201,
        response_time_ms: 3,
        request_payload: '{"item":"book"}',
        response_payload: '{"id":1}',
        request_headers: '{"content-type":"application/json"}',
        response_headers: '{"x-request-id":"r1"}',
      },
      "production",
      "",
      "storefront",
    ),
    ...overrides,
  };
}

function policy(overrides: Partial<RemotePolicy> = {}): RemotePolicy {
  return { ...CAPTURE_EVERYTHING, ...overrides };
}

describe("parseRemotePolicy", () => {
  it("reads the heartbeat response policy", () => {
    expect(parseRemotePolicy({
      policy: {
        enabled: false, sample_rate: 0.2, capture_headers: false,
        capture_request_body: false, capture_response_body: true, max_payload_bytes: 512,
      },
    })).toEqual({
      enabled: false, sampleRate: 0.2, captureHeaders: false,
      captureRequestBody: false, captureResponseBody: true, maxPayloadBytes: 512,
    });
  });

  it("is undefined without a policy object", () => {
    expect(parseRemotePolicy(undefined)).toBeUndefined();
    expect(parseRemotePolicy({ accepted: 1 })).toBeUndefined();
    expect(parseRemotePolicy({ policy: [] })).toBeUndefined();
  });

  it("narrows nothing through a missing or malformed field", () => {
    expect(parseRemotePolicy({
      policy: { enabled: "no", sample_rate: "0", capture_headers: 0, max_payload_bytes: -1 },
    })).toEqual({ ...CAPTURE_EVERYTHING });
  });

  it("clamps the sample rate into [0, 1]", () => {
    expect(parseRemotePolicy({ policy: { sample_rate: 7 } })?.sampleRate).toBe(1);
    expect(parseRemotePolicy({ policy: { sample_rate: -1 } })?.sampleRate).toBe(0);
  });
});

describe("applyRemotePolicy only narrows", () => {
  it("leaves a record alone under capture-everything", () => {
    const r = record();
    const before = { ...r };
    expect(applyRemotePolicy(r, policy(), () => 0.99)).toBe(true);
    expect(r).toEqual(before);
  });

  it("never resurrects a locally sampled-out record", () => {
    const r = record({ sampled: false, request_payload: "", response_payload: "", request_headers: "", response_headers: "" });
    applyRemotePolicy(r, policy({ sampleRate: 1 }), () => 0);
    expect(r.sampled).toBe(false);
    expect(r.request_payload).toBe("");
    expect(r.request_headers).toBe("");
  });

  it("drops the record when capture is disabled", () => {
    expect(applyRemotePolicy(record(), policy({ enabled: false }))).toBe(false);
  });

  it("samples out with the remote rate, keeping the base record", () => {
    const out = record();
    expect(applyRemotePolicy(out, policy({ sampleRate: 0.3 }), () => 0.5)).toBe(true);
    expect(out.sampled).toBe(false);
    expect(out).toMatchObject({ request_payload: "", response_payload: "", request_headers: "", response_headers: "" });
    expect(out.status_code).toBe(201);

    const kept = record();
    applyRemotePolicy(kept, policy({ sampleRate: 0.3 }), () => 0.1);
    expect(kept.sampled).toBe(true);
    expect(kept.request_payload).not.toBe("");
  });

  it("strips headers and bodies the policy turns off", () => {
    const r = record();
    applyRemotePolicy(r, policy({ captureHeaders: false, captureRequestBody: false }));
    expect(r.request_headers).toBe("");
    expect(r.response_headers).toBe("");
    expect(r.request_payload).toBe("");
    expect(r.response_payload).toBe('{"id":1}');
  });

  it("cuts bodies to max_payload_bytes without splitting a character", () => {
    const r = record({ request_payload: "héllo wörld", response_payload: "ok" });
    applyRemotePolicy(r, policy({ maxPayloadBytes: 2 }));
    expect(r.request_payload).toBe("h"); // "é" is two bytes and would not fit
    expect(r.response_payload).toBe("ok");
  });

  it("narrowPayloadBytes takes the smaller cap", () => {
    expect(narrowPayloadBytes(8192, null)).toBe(8192);
    expect(narrowPayloadBytes(8192, policy({ maxPayloadBytes: null }))).toBe(8192);
    expect(narrowPayloadBytes(8192, policy({ maxPayloadBytes: 100 }))).toBe(100);
    expect(narrowPayloadBytes(100, policy({ maxPayloadBytes: 1 << 20 }))).toBe(100);
  });
});

describe("remote policy through the Express middleware", () => {
  let batches: Array<{ requests: Array<Record<string, unknown>> }>;
  let heartbeatPolicy: Record<string, unknown>;

  beforeEach(() => {
    process.env.APILENS_SEND_HEARTBEAT = "true";
    batches = [];
    heartbeatPolicy = EVERYTHING_WIRE;
  });

  afterEach(async () => {
    await ApiLensClient.shutdown();
    process.env.APILENS_SEND_HEARTBEAT = "false";
  });

  async function run(config: Partial<ApiLensExpressConfig>): Promise<Array<Record<string, unknown>>> {
    const app = express();
    app.use(express.json());
    const mw = createApiLensMiddleware({
      apiKey: "test",
      appId: "storefront",
      baseUrl: "http://ingest.test/v1",
      compress: false,
      defaultExclusions: false,
      logger: { debug() {}, warn() {}, error() {} },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/heartbeat")) {
          return new Response(JSON.stringify({ policy: heartbeatPolicy }), { status: 200 });
        }
        batches.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 202 });
      }) as typeof fetch,
      ...config,
    });
    app.use(mw);
    app.post("/orders", (req, res) => {
      res.json({ id: 1, item: req.body.item });
    });
    const client = mw.apilensClient;
    client.stop();
    expect(await client.sendHeartbeat()).toBe(true);

    await request(app).post("/orders").send({ item: "a long book title" }).expect(200);
    await client.flushAll();
    return batches.flatMap((b) => b.requests);
  }

  it("a capture-everything policy does not widen a narrow local config", async () => {
    const [r] = await run({
      sampleRate: 0,
      requestLogging: { captureHeaders: false, logRequestBody: false, maxPayloadBytes: 4 },
    });
    expect(r.sampled).toBe(false);
    expect(r.request_headers).toBe("");
    expect(r.request_payload).toBe("");
    expect(r.response_payload).toBe("");
  });

  it("local narrowing wins field by field under capture-everything", async () => {
    const [r] = await run({
      requestLogging: { captureHeaders: false, logRequestBody: false, maxPayloadBytes: 4 },
    });
    expect(r.sampled).toBe(true);
    expect(r.request_headers).toBe("");
    expect(r.response_headers).toBe("");
    expect(r.request_payload).toBe("");
    expect(Buffer.byteLength(String(r.response_payload))).toBeLessThanOrEqual(4);
  });

  it("a narrower remote policy narrows a capture-everything local config", async () => {
    heartbeatPolicy = {
      ...EVERYTHING_WIRE,
      capture_headers: false,
      capture_response_body: false,
      max_payload_bytes: 6,
    };
    const [r] = await run({});
    expect(r.request_headers).toBe("");
    expect(r.response_headers).toBe("");
    expect(r.response_payload).toBe("");
    expect(r.request_payload).toBe('{"item');
  });

  it("remote sample_rate 0 keeps only the base record", async () => {
    heartbeatPolicy = { ...EVERYTHING_WIRE, sample_rate: 0 };
    const [r] = await run({});
    expect(r.sampled).toBe(false);
    expect(r.status_code).toBe(200);
    expect(r.request_payload).toBe("");
    expect(r.request_headers).toBe("");
  });

  it("enabled=false stops sending records; the next heartbeat can re-enable", async () => {
    heartbeatPolicy = { ...EVERYTHING_WIRE, enabled: false };
    expect(await run({})).toHaveLength(0);

    const client = ApiLensClient.getInstance();
    expect(client.isCapturing()).toBe(false);
    heartbeatPolicy = EVERYTHING_WIRE;
    expect(await client.sendHeartbeat()).toBe(true);
    expect(client.isCapturing()).toBe(true);
  });
});
