/**
 * PII redaction: same vectors as the Python SDK's tests/test_default_masking.py
 * (built-in defaults always on, user patterns extend them) plus the Express
 * wiring.
 */
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import {
  DEFAULT_MASK_BODY_FIELDS,
  DEFAULT_MASK_HEADER_PATTERNS,
  DEFAULT_MASK_QUERY_PARAMS,
  MAX_BODY_DEPTH,
  REDACTED,
  Redactor,
  SENSITIVE_HEADERS,
  serializeHeaders,
} from "../src/sanitize.js";
import type { ApiLensRecordInput } from "../src/types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await ApiLensClient.shutdown();
});

describe("default pattern lists", () => {
  it("are verbatim ports of the Python defaults", () => {
    expect(DEFAULT_MASK_QUERY_PARAMS).toEqual(["auth", "api.?key", "secret", "token", "password", "pwd"]);
    expect(DEFAULT_MASK_HEADER_PATTERNS).toEqual(["auth", "api.?key", "secret", "token", "cookie"]);
    expect(DEFAULT_MASK_BODY_FIELDS).toEqual([
      "password",
      "pwd",
      "token",
      "secret",
      "auth",
      "card.?number",
      "ccv",
      "cvv",
      "cvc",
      "ssn",
    ]);
    expect(SENSITIVE_HEADERS.has("x-amz-security-token")).toBe(true);
    expect(SENSITIVE_HEADERS.has("proxy-authorization")).toBe(true);
  });
});

describe("Redactor.redactQuery", () => {
  it.each([
    "auth",
    "api_key",
    "apikey",
    "api-key",
    "client_secret",
    "token",
    "access_token",
    "password",
    "pwd",
    "AUTH_CODE",
  ])("masks default param %s", (name) => {
    expect(new Redactor().redactQuery(`${name}=s3cr3t&page=2`)).toBe(`${name}=${REDACTED}&page=2`);
  });

  it("masks token with no user config", () => {
    expect(new Redactor().redactQuery("token=abc")).toBe("token=[redacted]");
  });

  it("leaves a query without sensitive params untouched byte for byte", () => {
    const query = "q=hello%20world&page=2&tags=a+b";
    expect(new Redactor().redactQuery(query)).toBe(query);
  });

  it("user patterns extend the defaults", () => {
    const out = new Redactor({ queryParams: ["^card_number$"] }).redactQuery(
      "card_number=4242&token=t&page=1",
    );
    expect(out).toBe(`card_number=${REDACTED}&token=${REDACTED}&page=1`);
  });

  it("re-encodes other values like Python urlencode(quote_via=quote, safe='[]')", () => {
    const out = new Redactor().redactQuery("token=x&q=a+b%2Fc&flag&e=caf%C3%A9&p=(1)!");
    expect(out).toBe("token=[redacted]&q=a%20b%2Fc&flag=&e=caf%C3%A9&p=%281%29%21");
  });

  it("passes empty and pair-less queries through", () => {
    const redactor = new Redactor();
    expect(redactor.redactQuery("")).toBe("");
    expect(redactor.redactQuery("&&")).toBe("&&");
  });

  it("tolerates malformed percent escapes", () => {
    expect(new Redactor().redactQuery("token=%zz&q=%E0%A4")).toBe("token=[redacted]&q=%EF%BF%BD");
  });

  it("accepts RegExp patterns and matches case-insensitively", () => {
    const out = new Redactor({ queryParams: [/^SESSION$/] }).redactQuery("session=1&page=2");
    expect(out).toBe(`session=${REDACTED}&page=2`);
  });
});

describe("headers", () => {
  it.each(["x-auth-user", "x-apikey", "x-api_key", "x-client-secret", "x-refresh-token", "x-session-cookie"])(
    "masks default header pattern %s",
    (name) => {
      for (const redactor of [undefined, new Redactor()]) {
        const blob = JSON.parse(serializeHeaders({ [name]: "v", accept: "json" }, { redactor }));
        expect(blob).toEqual({ [name]: REDACTED, accept: "json" });
      }
    },
  );

  it("keeps the exact sensitive header names", () => {
    const blob = JSON.parse(serializeHeaders({ "x-amz-security-token": "v", "set-cookie": "c" }));
    expect(blob).toEqual({ "x-amz-security-token": REDACTED, "set-cookie": REDACTED });
  });

  it("user header patterns extend the defaults", () => {
    const blob = JSON.parse(
      serializeHeaders(
        { "x-internal": "v", "x-auth": "a", accept: "json" },
        { redactor: new Redactor({ headers: ["^x-internal$"] }) },
      ),
    );
    expect(blob).toEqual({ "x-internal": REDACTED, "x-auth": REDACTED, accept: "json" });
  });
});

describe("Redactor.redactBody", () => {
  it.each([
    "password",
    "pwd",
    "token",
    "client_secret",
    "auth",
    "card_number",
    "cardnumber",
    "ccv",
    "cvv",
    "cvc",
    "ssn",
  ])("masks default field %s", (field) => {
    const out = JSON.parse(new Redactor().redactBody(JSON.stringify({ [field]: "x", name: "Ada" })));
    expect(out).toEqual({ [field]: REDACTED, name: "Ada" });
  });

  it("masks numbers as well as strings", () => {
    const body = JSON.stringify({ card_number: 4242424242424242, cvv: 123, ssn: 1.5, amount: 10 });
    expect(JSON.parse(new Redactor().redactBody(body))).toEqual({
      card_number: REDACTED,
      cvv: REDACTED,
      ssn: REDACTED,
      amount: 10,
    });
  });

  it("keeps booleans and null", () => {
    const body = JSON.stringify({ token: null, password_set: true, user: { auth: false } });
    expect(new Redactor().redactBody(body)).toBe(body);
  });

  it("masks nested objects and arrays, and a matching container whole", () => {
    const body = JSON.stringify({
      user: { name: "Ada", password: "p" },
      items: [{ cvc: "1" }],
      auth: { user: "u", pass: "p" },
    });
    expect(JSON.parse(new Redactor().redactBody(body))).toEqual({
      user: { name: "Ada", password: REDACTED },
      items: [{ cvc: REDACTED }],
      auth: REDACTED,
    });
  });

  it("leaves a body without sensitive fields untouched byte for byte", () => {
    const body = '{ "name": "Ada",\n  "amount": 10 }';
    expect(new Redactor().redactBody(body)).toBe(body);
  });

  it("passes non-JSON and scalar JSON through", () => {
    const redactor = new Redactor();
    expect(redactor.redactBody("password=p")).toBe("password=p");
    expect(redactor.redactBody('"password"')).toBe('"password"');
    expect(redactor.redactBody('{"password": "trunc')).toBe('{"password": "trunc');
  });

  it("user body patterns extend the defaults", () => {
    const out = JSON.parse(
      new Redactor({ bodyFields: ["^iban$"] }).redactBody('{"iban":"DE00","password":"p","n":1}'),
    );
    expect(out).toEqual({ iban: REDACTED, password: REDACTED, n: 1 });
  });

  it("stops walking past the depth cap", () => {
    // The object holding the field sits at depth N after N wrappers; depth
    // MAX_BODY_DEPTH is still walked, one deeper is not (Python parity).
    const nest = (levels: number): string => {
      let node: unknown = { password: "p" };
      for (let i = 0; i < levels; i += 1) {
        node = i % 2 === 0 ? { a: node } : [node];
      }
      return JSON.stringify(node);
    };
    expect(new Redactor().redactBody(nest(MAX_BODY_DEPTH))).toContain(REDACTED);
    const body = nest(MAX_BODY_DEPTH + 1);
    expect(new Redactor().redactBody(body)).toBe(body);
  });

  it("treats a __proto__ key as a plain field", () => {
    const out = new Redactor().redactBody('{"__proto__":{"token":"t"},"password":"p"}');
    expect(out).toBe('{"__proto__":{"token":"[redacted]"},"password":"[redacted]"}');
  });
});

describe("construction", () => {
  it("compiles patterns once, not per call", () => {
    const redactor = new Redactor({ queryParams: ["^x$"], headers: ["^y$"], bodyFields: ["^z$"] });
    const spy = vi.spyOn(globalThis, "RegExp");
    expect(redactor.redactQuery("token=a&x=1")).toBe(`token=${REDACTED}&x=${REDACTED}`);
    expect(JSON.parse(redactor.redactBody('{"password":"p","z":1}'))).toEqual({
      password: REDACTED,
      z: REDACTED,
    });
    expect(JSON.parse(serializeHeaders({ "x-auth": "a", y: "b" }, { redactor }))).toEqual({
      "x-auth": REDACTED,
      y: REDACTED,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws on an invalid user pattern", () => {
    expect(() => new Redactor({ queryParams: ["("] })).toThrow(SyntaxError);
    expect(() => useApiLens(express(), { apiKey: "k", appId: "a", redactBodyFields: ["["] })).toThrow(SyntaxError);
  });
});

describe("Express wiring", () => {
  function makeApp(config: Record<string, unknown> = {}) {
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
    useApiLens(app, { client, ...config });
    return { app, captured };
  }

  it("redacts headers and both bodies with no config, before capture", async () => {
    const { app, captured } = makeApp();
    app.post("/login", (_req, res) => {
      res.setHeader("x-refresh-token", "r-1");
      res.json({ token: "t-123", ok: true });
    });

    await request(app)
      .post("/login")
      .set("X-Api-Key", "k")
      .set("X-Session-Cookie", "c")
      .send({ email: "ada@example.com", password: "hunter2", card: { cvv: 123 } })
      .expect(200);

    expect(captured).toHaveLength(1);
    const rec = captured[0];
    expect(JSON.parse(rec.request_payload || "")).toEqual({
      email: "ada@example.com",
      password: REDACTED,
      card: { cvv: REDACTED },
    });
    expect(JSON.parse(rec.response_payload || "")).toEqual({ token: REDACTED, ok: true });
    const reqHeaders = JSON.parse(rec.request_headers || "");
    expect(reqHeaders["x-api-key"]).toBe(REDACTED);
    expect(reqHeaders["x-session-cookie"]).toBe(REDACTED);
    expect(JSON.parse(rec.response_headers || "")["x-refresh-token"]).toBe(REDACTED);

    const serialized = JSON.stringify(rec);
    for (const secret of ["hunter2", "t-123", "r-1", '"k"']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("applies user patterns from the middleware config", async () => {
    const { app, captured } = makeApp({
      redactHeaders: ["^x-tenant$"],
      redactBodyFields: [/^iban$/],
    });
    app.post("/pay", (_req, res) => {
      res.json({ iban: "DE00", ok: true });
    });

    await request(app)
      .post("/pay")
      .set("X-Tenant", "acme")
      .send({ iban: "DE11", amount: 5 })
      .expect(200);

    const rec = captured[0];
    expect(JSON.parse(rec.request_payload || "")).toEqual({ iban: REDACTED, amount: 5 });
    expect(JSON.parse(rec.response_payload || "")).toEqual({ iban: REDACTED, ok: true });
    expect(JSON.parse(rec.request_headers || "")["x-tenant"]).toBe(REDACTED);
  });
});
