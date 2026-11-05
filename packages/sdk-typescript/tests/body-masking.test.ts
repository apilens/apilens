/**
 * Body mask callbacks (`maskRequestBody` / `maskResponseBody`) and
 * content-type aware body capture: callbacks run on the raw Buffer BEFORE the
 * regex field masking, fail closed to `[masked]`, and bodies outside the
 * captured media types are stored as a placeholder. Mirrors the Python SDK's
 * `mask_body` / `capture_body` / `ContentTypeFilter`.
 */
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import {
  ContentTypeFilter,
  DEFAULT_CAPTURE_CONTENT_TYPES,
  MASKED,
  REDACTED,
  Redactor,
  captureBody,
  decodeUtf8Safe,
  maskBody,
  omittedBody,
} from "../src/sanitize.js";
import type { RequestBodyInfo, ResponseBodyInfo } from "../src/sanitize.js";
import type { ApiLensExpressConfig, ApiLensRecordInput } from "../src/types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await ApiLensClient.shutdown();
});

const redactor = new Redactor();
const json = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

describe("maskBody", () => {
  it("runs the callback on the raw Buffer before the regex field masking", () => {
    const calls: string[] = [];
    const out = maskBody(json({ password: "p", note: "keep" }), {
      redactor,
      contentType: "application/json",
      masker: (_info, body) => {
        calls.push("callback");
        expect(Buffer.isBuffer(body)).toBe(true);
        // The callback still sees the raw value: regex masking has not run yet.
        expect(JSON.parse(body.toString("utf8")).password).toBe("p");
        return json({ ...JSON.parse(body.toString("utf8")), note: "rewritten" });
      },
    });
    expect(calls).toEqual(["callback"]);
    // Built-ins still apply to what the callback returned.
    expect(JSON.parse(out)).toEqual({ password: REDACTED, note: "rewritten" });
  });

  it("cannot switch the built-ins off by re-adding a secret", () => {
    const out = maskBody(json({ a: 1 }), {
      redactor,
      masker: () => json({ token: "leak" }),
    });
    expect(JSON.parse(out)).toEqual({ token: REDACTED });
  });

  it("applies user regex patterns after the callback too", () => {
    const out = maskBody(json({ a: 1 }), {
      redactor: new Redactor({ bodyFields: ["^iban$"] }),
      masker: () => json({ iban: "DE00", a: 1 }),
    });
    expect(JSON.parse(out)).toEqual({ iban: REDACTED, a: 1 });
  });

  it("stores [masked] when the callback returns null", () => {
    expect(maskBody(json({ a: 1 }), { redactor, masker: () => null })).toBe(MASKED);
  });

  it("stores [masked] when the callback returns undefined", () => {
    expect(maskBody(json({ a: 1 }), { redactor, masker: () => undefined })).toBe(MASKED);
  });

  it("fails closed when the callback throws", () => {
    const out = maskBody(json({ secret_value: "raw" }), {
      redactor,
      masker: () => {
        throw new Error("boom");
      },
    });
    expect(out).toBe(MASKED);
  });

  it.each([
    ["a number", 42],
    ["an object", { a: 1 }],
    ["a promise", Promise.resolve(Buffer.from("x"))],
  ])("fails closed when the callback returns %s", (_label, value) => {
    const out = maskBody(json({ a: 1 }), {
      redactor,
      masker: () => value as unknown as Buffer,
    });
    expect(out).toBe(MASKED);
  });

  it("accepts a string or Uint8Array return", () => {
    expect(maskBody(json({}), { redactor, masker: () => "plain text" })).toBe("plain text");
    expect(
      maskBody(json({}), { redactor, masker: () => new TextEncoder().encode("bytes") as Buffer }),
    ).toBe("bytes");
  });

  it("gives the callback a copy it cannot mutate the capture through", () => {
    const original = Buffer.from("abc");
    maskBody(original, {
      redactor,
      masker: (_info, body) => {
        body.fill(0x7a);
        return body;
      },
    });
    expect(original.toString()).toBe("abc");
  });

  it("passes the info object through", () => {
    const info = { method: "POST" } as RequestBodyInfo;
    const seen: unknown[] = [];
    maskBody(Buffer.from("x"), {
      redactor,
      info,
      masker: (i) => {
        seen.push(i);
        return Buffer.from("x");
      },
    });
    expect(seen).toEqual([info]);
  });

  it("does not call the callback for an empty body", () => {
    const masker = vi.fn(() => null);
    expect(maskBody(Buffer.alloc(0), { redactor, masker })).toBe("");
    expect(masker).not.toHaveBeenCalled();
  });

  it("masks form-encoded bodies field by field", () => {
    const out = maskBody(Buffer.from("user=ada&password=hunter2&api_key=k"), {
      redactor,
      contentType: "application/x-www-form-urlencoded; charset=utf-8",
    });
    expect(out).toBe(`user=ada&password=${REDACTED}&api_key=${REDACTED}`);
  });

  it("leaves non-JSON text untouched by the field masking", () => {
    expect(maskBody(Buffer.from("password=x in prose"), { redactor, contentType: "text/plain" })).toBe(
      "password=x in prose",
    );
  });
});

describe("decodeUtf8Safe", () => {
  it("drops a multibyte character cut at the tail", () => {
    const bytes = Buffer.from("héllo €", "utf8");
    expect(decodeUtf8Safe(bytes.subarray(0, bytes.length - 1))).toBe("héllo ");
    expect(decodeUtf8Safe(bytes)).toBe("héllo €");
  });
});

describe("ContentTypeFilter", () => {
  const filter = new ContentTypeFilter();

  it("defaults to JSON, text and form bodies", () => {
    expect(DEFAULT_CAPTURE_CONTENT_TYPES).toEqual([
      "application/json",
      "application/*+json",
      "text/*",
      "application/x-www-form-urlencoded",
    ]);
  });

  it.each([
    "application/json",
    "Application/JSON; charset=utf-8",
    "application/problem+json",
    "text/plain",
    "text/html; charset=utf-8",
    "application/x-www-form-urlencoded",
  ])("captures %s", (ct) => {
    expect(filter.allows(ct)).toBe(true);
  });

  it.each([
    "multipart/form-data; boundary=x",
    "application/octet-stream",
    "image/png",
    "application/zip",
    "",
    undefined,
  ])("does not capture %s", (ct) => {
    expect(filter.allows(ct)).toBe(false);
  });

  it("replaces the defaults with user globs (string or list)", () => {
    const custom = new ContentTypeFilter("application/xml, image/*");
    expect(custom.allows("application/xml")).toBe(true);
    expect(custom.allows("image/png")).toBe(true);
    expect(custom.allows("application/json")).toBe(false);
    expect(new ContentTypeFilter(["application/x.y"]).allows("application/xzy")).toBe(false);
  });
});

describe("captureBody / omittedBody", () => {
  it("stores a placeholder for a non-captured type and never runs the callback", () => {
    const masker = vi.fn(() => Buffer.from("x"));
    const out = captureBody(Buffer.alloc(0), {
      size: 1234,
      contentType: "multipart/form-data; boundary=abc",
      contentTypes: new ContentTypeFilter(),
      redactor,
      masker,
    });
    expect(out).toBe("[multipart/form-data, 1234 bytes omitted]");
    expect(masker).not.toHaveBeenCalled();
  });

  it("treats a missing content type as application/octet-stream", () => {
    expect(omittedBody(undefined, 7)).toBe("[application/octet-stream, 7 bytes omitted]");
  });

  it("stores nothing for an empty non-captured body", () => {
    expect(omittedBody("image/png", 0)).toBe("");
  });
});

describe("Express wiring", () => {
  function makeApp(config: Partial<ApiLensExpressConfig> = {}) {
    const client = new ApiLensClient({
      apiKey: "test-api-key",
      appId: "test-app",
      batchSize: 100,
      compress: false,
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    const captured: ApiLensRecordInput[] = [];
    const original = client.capture.bind(client);
    vi.spyOn(client, "capture").mockImplementation((input: ApiLensRecordInput) => {
      captured.push(structuredClone(input));
      return original(input);
    });
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(express.text());
    useApiLens(app, { client, ...config });
    return { app, captured };
  }

  it("runs both callbacks with request/response info, then the built-ins", async () => {
    const requestInfos: RequestBodyInfo[] = [];
    const responseInfos: ResponseBodyInfo[] = [];
    const { app, captured } = makeApp({
      maskRequestBody: (info, body) => {
        requestInfos.push(info);
        const data = JSON.parse(body.toString("utf8"));
        // Raw value visible to the callback; the built-in masks it afterwards.
        expect(data.password).toBe("hunter2");
        return json({ ...data, email: "hidden" });
      },
      maskResponseBody: (info, body) => {
        responseInfos.push(info);
        return info.statusCode === 201 ? body : null;
      },
    });
    app.post("/users/:id", (_req, res) => {
      res.status(201).json({ id: 7, token: "t-1" });
    });

    await request(app)
      .post("/users/7?api_key=k&page=1")
      .set("X-Tenant", "acme")
      .send({ email: "ada@example.com", password: "hunter2" })
      .expect(201);

    const rec = captured[0];
    expect(JSON.parse(rec.request_payload || "")).toEqual({ email: "hidden", password: REDACTED });
    expect(JSON.parse(rec.response_payload || "")).toEqual({ id: 7, token: REDACTED });

    expect(requestInfos).toHaveLength(1);
    expect(requestInfos[0]).toMatchObject({
      method: "POST",
      path: "/users/7",
      rawPath: `/users/7?api_key=${REDACTED}&page=1`,
      contentType: "application/json",
    });
    expect(requestInfos[0].headers["x-tenant"]).toBe("acme");
    expect(responseInfos[0].statusCode).toBe(201);
    expect(responseInfos[0].contentType).toMatch(/^application\/json/);
    expect(responseInfos[0].request).toBe(requestInfos[0]);
  });

  it("stores [masked] for per-route drops and for a throwing callback", async () => {
    const { app, captured } = makeApp({
      maskRequestBody: (info) => {
        if (info.path === "/boom") {
          throw new Error("bad masker");
        }
        return null;
      },
      maskResponseBody: (info, body) => (info.request.path === "/private" ? null : body),
    });
    app.post("/private", (_req, res) => {
      res.json({ ssn_like: "123" });
    });
    app.post("/boom", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).post("/private").send({ raw: "secret-value" }).expect(200);
    await request(app).post("/boom").send({ raw: "secret-value" }).expect(200);

    expect(captured[0].request_payload).toBe(MASKED);
    expect(captured[0].response_payload).toBe(MASKED);
    expect(captured[1].request_payload).toBe(MASKED);
    expect(JSON.parse(captured[1].response_payload || "")).toEqual({ ok: true });
    expect(JSON.stringify(captured)).not.toContain("secret-value");
  });

  it("masks a parsed form body field by field", async () => {
    const { app, captured } = makeApp();
    app.post("/login", (_req, res) => {
      res.type("text/plain").send("ok");
    });

    await request(app)
      .post("/login")
      .type("form")
      .send("user=ada&password=hunter2")
      .expect(200);

    expect(captured[0].request_payload).toBe(`user=ada&password=${REDACTED}`);
    expect(captured[0].response_payload).toBe("ok");
  });

  it("captures a text body handed to the callback as a Buffer", async () => {
    const { app, captured } = makeApp({
      maskRequestBody: (_info, body) => Buffer.from(body.toString("utf8").replace(/\d/g, "#")),
    });
    app.post("/note", (_req, res) => {
      res.status(204).end();
    });

    await request(app).post("/note").type("text/plain").send("call 555-0100").expect(204);

    expect(captured[0].request_payload).toBe("call ###-####");
    expect(captured[0].response_payload).toBe("");
  });

  it("stores a placeholder for multipart and binary bodies without calling the callbacks", async () => {
    const maskRequestBody = vi.fn((_info: RequestBodyInfo, body: Buffer) => body);
    const maskResponseBody = vi.fn((_info: ResponseBodyInfo, body: Buffer) => body);
    const { app, captured } = makeApp({ maskRequestBody, maskResponseBody });
    app.post("/upload", (_req, res) => {
      res.type("application/octet-stream").send(Buffer.alloc(300, 1));
    });
    app.get("/image", (_req, res) => {
      res.type("image/png").send(Buffer.alloc(50, 2));
    });

    await request(app)
      .post("/upload")
      .attach("file", Buffer.from("binary-file-contents"), "a.bin")
      .expect(200);
    await request(app).get("/image").expect(200);

    const upload = captured[0];
    expect(upload.request_payload).toMatch(/^\[multipart\/form-data, \d+ bytes omitted\]$/);
    expect(upload.response_payload).toBe("[application/octet-stream, 300 bytes omitted]");
    expect(captured[1].response_payload).toBe("[image/png, 50 bytes omitted]");
    expect(JSON.stringify(captured)).not.toContain("binary-file-contents");
    expect(maskRequestBody).not.toHaveBeenCalled();
    expect(maskResponseBody).not.toHaveBeenCalled();
  });

  it("captureContentTypes replaces the default list", async () => {
    const { app, captured } = makeApp({ captureContentTypes: ["text/csv"] });
    app.get("/report", (_req, res) => {
      res.type("text/csv").send("a,b\n1,2");
    });
    app.get("/data", (_req, res) => {
      res.json({ a: 1 });
    });

    await request(app).get("/report").expect(200);
    await request(app).get("/data").expect(200);

    expect(captured[0].response_payload).toBe("a,b\n1,2");
    expect(captured[1].response_payload).toMatch(/^\[application\/json, \d+ bytes omitted\]$/);
  });

  it("never runs the callbacks for a sampled-out request", async () => {
    const maskRequestBody = vi.fn(() => null);
    const { app, captured } = makeApp({ sampleRate: 0, maskRequestBody });
    app.post("/x", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).post("/x").send({ a: 1 }).expect(200);

    expect(captured[0].request_payload).toBe("");
    expect(maskRequestBody).not.toHaveBeenCalled();
  });
});
