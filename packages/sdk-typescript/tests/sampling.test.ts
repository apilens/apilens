import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import {
  Sampler,
  validateSampleRate,
  type SampleRequestInfo,
  type SampleResponseInfo,
} from "../src/sampling.js";
import type { ApiLensExpressConfig, ApiLensRecord } from "../src/types.js";

afterEach(async () => {
  await ApiLensClient.shutdown();
});

const reqInfo = (): SampleRequestInfo => ({
  method: "GET",
  path: "/orders",
  query: "",
  userAgent: "test",
  headers: {},
  clientIp: "127.0.0.1",
});

const resInfo = (statusCode = 200): SampleResponseInfo => ({
  method: "GET",
  route: "/orders",
  rawPath: "/orders",
  statusCode,
  responseTimeMs: 1,
  consumerId: "",
  consumerName: "",
  consumerGroup: "",
  sampled: true,
});

/** Deterministic PRNG (mulberry32) so the statistical test is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("validateSampleRate", () => {
  it("defaults to 1 and accepts the closed range [0, 1]", () => {
    expect(validateSampleRate(undefined)).toBe(1);
    expect(validateSampleRate(0)).toBe(0);
    expect(validateSampleRate(0.25)).toBe(0.25);
    expect(validateSampleRate(1)).toBe(1);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "0.5"])(
    "rejects %s",
    (value) => {
      expect(() => validateSampleRate(value)).toThrow(RangeError);
    },
  );

  it("rejects a non-function callback", () => {
    expect(() => new Sampler({ sampleOnRequest: 1 as never })).toThrow(TypeError);
    expect(() => new Sampler({ sampleOnResponse: "x" as never })).toThrow(TypeError);
  });
});

describe("Sampler: sampleRate", () => {
  it("is exact at 0 and 1 and never consults the PRNG there", () => {
    const random = vi.fn(() => 0.5);
    const none = new Sampler({ sampleRate: 0, random });
    const all = new Sampler({ sampleRate: 1, random });
    for (let i = 0; i < 1000; i += 1) {
      expect(none.decideRequest(reqInfo)).toBe(false);
      expect(all.decideRequest(reqInfo)).toBe(true);
    }
    expect(random).not.toHaveBeenCalled();
  });

  it.each([0.1, 0.3, 0.5, 0.9])("keeps ~%s of 10k requests (seeded)", (rate) => {
    const sampler = new Sampler({ sampleRate: rate, random: seeded(42) });
    let kept = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (sampler.decideRequest(reqInfo)) kept += 1;
    }
    expect(Math.abs(kept / 10_000 - rate)).toBeLessThan(0.02);
  });

  it("keeps ~30% of 10k requests with the default Math.random", () => {
    const sampler = new Sampler({ sampleRate: 0.3 });
    let kept = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (sampler.decideRequest(reqInfo)) kept += 1;
    }
    // 6+ standard deviations: flake-free while still catching a wrong rate.
    expect(Math.abs(kept / 10_000 - 0.3)).toBeLessThan(0.03);
  });
});

describe("Sampler: sampleOnRequest", () => {
  it("true / false are final, overriding sampleRate", () => {
    expect(new Sampler({ sampleRate: 0, sampleOnRequest: () => true }).decideRequest(reqInfo)).toBe(true);
    expect(new Sampler({ sampleRate: 1, sampleOnRequest: () => false }).decideRequest(reqInfo)).toBe(false);
  });

  it("a number is a probability (clamped to [0, 1])", () => {
    const low = new Sampler({ sampleOnRequest: () => 0.2, random: () => 0.1 });
    const high = new Sampler({ sampleOnRequest: () => 0.2, random: () => 0.3 });
    expect(low.decideRequest(reqInfo)).toBe(true);
    expect(high.decideRequest(reqInfo)).toBe(false);
    expect(new Sampler({ sampleOnRequest: () => 5 }).decideRequest(reqInfo)).toBe(true);
    expect(new Sampler({ sampleOnRequest: () => -1 }).decideRequest(reqInfo)).toBe(false);
  });

  it.each([undefined, null, Number.NaN])("%s falls back to sampleRate", (value) => {
    expect(new Sampler({ sampleRate: 0, sampleOnRequest: () => value }).decideRequest(reqInfo)).toBe(false);
    expect(new Sampler({ sampleRate: 1, sampleOnRequest: () => value }).decideRequest(reqInfo)).toBe(true);
  });

  it("a throwing callback counts as undefined and is logged once", () => {
    const warn = vi.fn();
    const sampler = new Sampler({
      sampleRate: 0,
      sampleOnRequest: () => {
        throw new Error("boom");
      },
      logger: { warn },
    });
    expect(sampler.decideRequest(reqInfo)).toBe(false);
    expect(sampler.decideRequest(reqInfo)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("Sampler: sampleOnResponse", () => {
  it("undefined keeps the prior decision", () => {
    const sampler = new Sampler({ sampleOnResponse: () => undefined });
    expect(sampler.decideResponse(true, () => resInfo())).toBe(true);
  });

  it("false drops, true keeps, a number is a probability", () => {
    expect(new Sampler({ sampleOnResponse: () => false }).decideResponse(true, () => resInfo())).toBe(false);
    expect(new Sampler({ sampleOnResponse: () => true }).decideResponse(true, () => resInfo())).toBe(true);
    expect(
      new Sampler({ sampleOnResponse: () => 0.5, random: () => 0.9 }).decideResponse(true, () => resInfo()),
    ).toBe(false);
  });

  it("cannot un-drop a request sampled out at request time", () => {
    const onResponse = vi.fn(() => true);
    const sampler = new Sampler({ sampleOnResponse: onResponse });
    expect(sampler.decideResponse(false, () => resInfo(500))).toBe(false);
    expect(onResponse).not.toHaveBeenCalled();
  });

  it("a throwing callback keeps the prior decision and is logged once", () => {
    const warn = vi.fn();
    const sampler = new Sampler({
      sampleOnResponse: () => {
        throw new Error("boom");
      },
      logger: { warn },
    });
    expect(sampler.decideResponse(true, () => resInfo())).toBe(true);
    expect(sampler.decideResponse(true, () => resInfo())).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

async function run(
  config: ApiLensExpressConfig,
  calls: Array<{ method: "get" | "post"; path: string; status?: number }>,
): Promise<ApiLensRecord[]> {
  const bodies: string[] = [];
  const app = express();
  app.use(express.json());
  useApiLens(app, {
    apiKey: "test-api-key",
    appId: "test-app",
    batchSize: 1000,
    compress: false,
    fetchImpl: async (_url, options) => {
      bodies.push(String(options?.body || ""));
      return new Response(null, { status: 200 });
    },
    ...config,
  });
  app.all("/orders", (req, res) => {
    const status = Number(req.query.status || 200);
    res.status(status).json({ ok: status < 400, item: req.body?.item ?? null });
  });

  for (const call of calls) {
    const path = call.status ? `${call.path}?status=${call.status}` : call.path;
    const r =
      call.method === "post"
        ? request(app).post(path).send({ item: "book" })
        : request(app).get(path);
    await r.set("X-Custom", "v").expect(call.status ?? 200);
  }
  await ApiLensClient.getInstance().flushAll();
  return bodies.flatMap((b) => JSON.parse(b).requests as ApiLensRecord[]);
}

function expectNoDetail(record: ApiLensRecord): void {
  expect(record.sampled).toBe(false);
  expect(record.request_payload).toBe("");
  expect(record.response_payload).toBe("");
  expect(record.request_headers).toBe("");
  expect(record.response_headers).toBe("");
}

describe("Express: base record always sent", () => {
  it("sampleRate 0 sends every record with base fields and no detail", async () => {
    const records = await run(
      { sampleRate: 0 },
      Array.from({ length: 20 }, () => ({ method: "post" as const, path: "/orders" })),
    );
    expect(records).toHaveLength(20);
    for (const record of records) {
      expectNoDetail(record);
      expect(record.method).toBe("POST");
      expect(record.path).toBe("/orders");
      expect(record.status_code).toBe(200);
      expect(record.response_size).toBeGreaterThan(0);
      expect(record.response_time_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("sampleRate 1 (the default) keeps full detail and sends sampled: true", async () => {
    const [record] = await run({}, [{ method: "post", path: "/orders" }]);
    expect(record.sampled).toBe(true);
    expect(record.request_payload).toContain('"item":"book"');
    expect(record.response_payload).toContain('"ok":true');
    expect(JSON.parse(record.request_headers)["x-custom"]).toBe("v");
    expect(record.response_headers).not.toBe("");
  });

  it("keep-only-errors: sampleOnResponse drops detail of non-error responses", async () => {
    const records = await run(
      { sampleOnResponse: (info) => info.statusCode >= 400 },
      [
        { method: "post", path: "/orders" },
        { method: "post", path: "/orders", status: 500 },
        { method: "post", path: "/orders", status: 404 },
      ],
    );
    expect(records.map((r) => [r.status_code, r.sampled])).toEqual([
      [200, false],
      [500, true],
      [404, true],
    ]);
    expectNoDetail(records[0]);
    expect(records[1].response_payload).toContain('"ok":false');
    expect(records[1].request_headers).not.toBe("");
  });

  it("sampleOnRequest receives the request view; its decision cannot be undone", async () => {
    const seen: SampleRequestInfo[] = [];
    const onResponse = vi.fn(() => true);
    const records = await run(
      {
        sampleOnRequest: (info) => {
          seen.push(info);
          return false;
        },
        sampleOnResponse: onResponse,
      },
      [{ method: "get", path: "/orders", status: 503 }],
    );
    expect(seen[0]).toMatchObject({
      method: "GET",
      path: "/orders",
      query: "status=503",
    });
    expect(seen[0].headers["x-custom"]).toBe("v");
    expect(onResponse).not.toHaveBeenCalled();
    expectNoDetail(records[0]);
    expect(records[0].status_code).toBe(503);
  });

  it("throwing callbacks never break the request and fall back", async () => {
    const records = await run(
      {
        sampleRate: 0,
        logger: { warn: () => {} },
        sampleOnRequest: () => {
          throw new Error("req");
        },
        sampleOnResponse: () => {
          throw new Error("res");
        },
      },
      [{ method: "get", path: "/orders" }],
    );
    expect(records).toHaveLength(1);
    expectNoDetail(records[0]);
  });

  it("rejects an out-of-range sampleRate at startup", () => {
    expect(() => useApiLens(express(), { apiKey: "k", appId: "a", sampleRate: 2 })).toThrow(RangeError);
  });
});

describe("client.capture", () => {
  it("strips detail from a record captured with sampled: false", async () => {
    const bodies: string[] = [];
    const client = new ApiLensClient({
      apiKey: "k",
      appId: "a",
      compress: false,
      fetchImpl: async (_url, options) => {
        bodies.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
    });
    client.capture({
      method: "GET",
      path: "/x",
      status_code: 200,
      response_time_ms: 1,
      request_payload: "secret",
      response_headers: "{}",
      sampled: false,
    });
    client.capture({ method: "GET", path: "/y", status_code: 200, response_time_ms: 1 });
    await client.flushAll();
    const [a, b] = bodies.flatMap((x) => JSON.parse(x).requests as ApiLensRecord[]);
    expectNoDetail(a);
    expect(b.sampled).toBe(true);
  });
});
