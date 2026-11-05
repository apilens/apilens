import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import {
  MAX_HEADER_BYTES,
  REDACTED,
  SENSITIVE_HEADERS,
  serializeHeaders,
} from "../src/sanitize.js";

afterEach(async () => {
  await ApiLensClient.shutdown();
});

describe("serializeHeaders", () => {
  it("returns empty string for no headers", () => {
    expect(serializeHeaders(undefined)).toBe("");
    expect(serializeHeaders(null)).toBe("");
    expect(serializeHeaders({})).toBe("");
    expect(serializeHeaders({ "x-empty": undefined })).toBe("");
  });

  it("lower-cases names and emits compact JSON", () => {
    const blob = serializeHeaders({ "Content-Type": "application/json", Accept: "*/*" });
    expect(blob).toBe('{"content-type":"application/json","accept":"*/*"}');
  });

  it("redacts every built-in sensitive header regardless of case", () => {
    const headers: Record<string, string> = {};
    for (const name of SENSITIVE_HEADERS) {
      headers[name.toUpperCase()] = "super-secret";
    }
    headers["x-request-id"] = "abc";
    const parsed = JSON.parse(serializeHeaders(headers));
    for (const name of SENSITIVE_HEADERS) {
      expect(parsed[name]).toBe(REDACTED);
    }
    expect(parsed["x-request-id"]).toBe("abc");
    expect(JSON.stringify(parsed)).not.toContain("super-secret");
  });

  it("redacts names matching the default mask patterns", () => {
    const parsed = JSON.parse(
      serializeHeaders({
        "X-Client-Secret": "s1",
        "X-Refresh-Token": "t1",
        "X-My-ApiKey": "k1",
        "X-Api_Key": "k2",
        "X-Session-Cookie": "c1",
        "X-Custom-Auth": "a1",
        "X-Trace": "keep",
      }),
    );
    expect(parsed).toEqual({
      "x-client-secret": REDACTED,
      "x-refresh-token": REDACTED,
      "x-my-apikey": REDACTED,
      "x-api_key": REDACTED,
      "x-session-cookie": REDACTED,
      "x-custom-auth": REDACTED,
      "x-trace": "keep",
    });
  });

  it("joins multi-value headers and stringifies numbers", () => {
    const parsed = JSON.parse(
      serializeHeaders({ vary: ["Accept", "Origin"], "content-length": 42 }),
    );
    expect(parsed).toEqual({ vary: "Accept, Origin", "content-length": "42" });
  });

  it("caps at 8 KB by dropping the longest values first", () => {
    const blob = serializeHeaders({
      "x-small": "a",
      "x-big": "b".repeat(6000),
      "x-medium": "c".repeat(3000),
    });
    expect(Buffer.byteLength(blob, "utf8")).toBeLessThanOrEqual(MAX_HEADER_BYTES);
    const parsed = JSON.parse(blob);
    expect(parsed["x-big"]).toBeUndefined();
    expect(parsed["x-medium"]).toBe("c".repeat(3000));
    expect(parsed["x-small"]).toBe("a");
  });

  it("drops only as many keys as needed and honours maxBytes", () => {
    const blob = serializeHeaders(
      { a: "1".repeat(30), b: "2".repeat(20), c: "3" },
      { maxBytes: 40 },
    );
    // Without a: {"b":"22..","c":"3"} = 34 bytes, fits.
    expect(blob).toBe(`{"b":"${"2".repeat(20)}","c":"3"}`);
  });

  it("measures the cap in UTF-8 bytes", () => {
    const blob = serializeHeaders(
      { "x-emoji": "\u{1F600}".repeat(10), "x-ascii": "a".repeat(30) },
      { maxBytes: 60 },
    );
    // emoji: 10 code points (40 bytes) vs ascii: 30 code points -> ascii dropped first.
    expect(JSON.parse(blob)).toEqual({ "x-emoji": "\u{1F600}".repeat(10) });
  });
});

describe("Express header capture", () => {
  function appWith(captureHeaders?: boolean) {
    const bodies: string[] = [];
    const app = express();
    useApiLens(app, {
      apiKey: "test-api-key",
      appId: "test-app",
      batchSize: 100,
      requestLogging: captureHeaders === undefined ? {} : { captureHeaders },
      compress: false,
      fetchImpl: async (_url, options) => {
        bodies.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
    });
    app.get("/me", (_req, res) => {
      res.set("X-Request-Id", "req-1");
      res.cookie("sid", "session-secret");
      res.json({ ok: true });
    });
    return { app, bodies };
  }

  it("captures redacted request and response headers by default", async () => {
    const { app, bodies } = appWith();
    await request(app)
      .get("/me")
      .set("Authorization", "Bearer secret-token")
      .set("X-Tenant", "acme")
      .expect(200);
    await ApiLensClient.getInstance().flushAll();

    const record = JSON.parse(bodies[0]).requests[0];
    const reqHeaders = JSON.parse(record.request_headers);
    expect(reqHeaders.authorization).toBe(REDACTED);
    expect(reqHeaders["x-tenant"]).toBe("acme");
    expect(record.request_headers).not.toContain("secret-token");

    const resHeaders = JSON.parse(record.response_headers);
    expect(resHeaders["x-request-id"]).toBe("req-1");
    expect(resHeaders["set-cookie"]).toBe(REDACTED);
    expect(record.response_headers).not.toContain("session-secret");
  });

  it("sends empty header fields when captureHeaders is false", async () => {
    const { app, bodies } = appWith(false);
    await request(app).get("/me").set("X-Tenant", "acme").expect(200);
    await ApiLensClient.getInstance().flushAll();

    const record = JSON.parse(bodies[0]).requests[0];
    expect(record.request_headers).toBe("");
    expect(record.response_headers).toBe("");
  });
});
