// "Continue with SSO" (#323): the client helpers and the `POST /api/auth/sso/lookup` and
// `POST /api/auth/email/start` (sso_required) Route Handlers, against a mocked identity server (a
// real HTTP server on a random port that APILENS_API_URL points at). Addresses are @example.com only.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupSSO, ssoLabel, ssoRequiredMatch, ssoStartHref } from "./sso";

const PUBLIC_URL = "http://ui.apilens.test";
const START = "https://id.apilens.test/api/v1/auth/sso/acme/start";

describe("ssoStartHref", () => {
  it("adds next, remember and login_hint", () => {
    const href = new URL(ssoStartHref(START, { email: "ada@example.com", next: "/acme/requests" }) ?? "");
    expect(href.origin + href.pathname).toBe(START);
    expect(Object.fromEntries(href.searchParams)).toEqual({
      next: "/acme/requests",
      remember: "true",
      login_hint: "ada@example.com",
    });
  });

  it("only sets remember without other options", () => {
    expect(ssoStartHref(START)).toBe(`${START}?remember=true`);
  });

  it.each([undefined, null, "", "not a url", "/relative", "javascript:alert(1)", "data:text/html,x", 42])(
    "refuses %s",
    (value) => {
      expect(ssoStartHref(value)).toBeNull();
    },
  );

  it("ssoRequiredMatch turns a refusal's start_url into an enforced match", () => {
    expect(ssoRequiredMatch(START)).toEqual({ orgName: null, enforced: true, startUrl: `${START}?remember=true` });
    expect(ssoRequiredMatch("javascript:alert(1)")).toBeNull();
  });

  it("ssoLabel names the organization when known", () => {
    expect(ssoLabel("Acme")).toBe("Continue with Acme SSO");
    expect(ssoLabel(null)).toBe("Continue with SSO");
  });
});

describe("lookupSSO", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("posts {email, next} to the Route Handler", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, sso: false, enforced: false }));
    await lookupSSO({ email: " ada@example.com ", next: "/orgs" }, fetcher);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/auth/sso/lookup");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "ada@example.com", next: "/orgs" });
  });

  it("returns the match with the Route Handler's start URL untouched", async () => {
    const startUrl = `${START}?remember=true&login_hint=ada%40example.com`;
    const fetcher = vi.fn<typeof fetch>(async () =>
      json(200, { ok: true, sso: true, enforced: true, org_name: "Acme", start_url: startUrl }),
    );
    expect(await lookupSSO({ email: "ada@example.com" }, fetcher)).toEqual({
      kind: "match",
      match: { orgName: "Acme", enforced: true, startUrl },
    });
  });

  it("is a non-enforced match unless enforced is true, and tolerates a missing name", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, sso: true, enforced: "yes", start_url: START }));
    expect(await lookupSSO({ email: "ada@example.com" }, fetcher)).toEqual({
      kind: "match",
      match: { orgName: null, enforced: false, startUrl: START },
    });
  });

  it("is none for no SSO or an unusable start URL", async () => {
    const none = vi.fn<typeof fetch>(async () => json(200, { ok: true, sso: false, enforced: false }));
    expect(await lookupSSO({ email: "ada@example.com" }, none)).toEqual({ kind: "none" });
    const bad = vi.fn<typeof fetch>(async () => json(200, { ok: true, sso: true, enforced: true, start_url: "javascript:x" }));
    expect(await lookupSSO({ email: "ada@example.com" }, bad)).toEqual({ kind: "none" });
  });

  it("is an error for a refusal, a non-JSON body or no connection", async () => {
    const limited = vi.fn<typeof fetch>(async () => json(429, { ok: false, code: "rate_limited" }));
    expect(await lookupSSO({ email: "ada@example.com" }, limited)).toEqual({ kind: "error" });
    const html = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 200 }));
    expect(await lookupSSO({ email: "ada@example.com" }, html)).toEqual({ kind: "error" });
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await lookupSSO({ email: "ada@example.com" }, offline)).toEqual({ kind: "error" });
  });
});

// ---------------------------------------------------------------------------------------------
// Route Handlers

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}
type Reply = { status: number; body?: unknown };

let server: Server;
let seen: Seen[] = [];
let replies: Record<string, (req: Seen) => Reply> = {};

function handle(req: IncomingMessage, res: ServerResponse) {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const entry: Seen = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const reply = replies[`${entry.method} ${entry.path.split("?")[0]}`]?.(entry) ?? {
      status: 404,
      body: { status: 404, title: "Not Found", code: "not_found" },
    };
    res.writeHead(reply.status, { "content-type": reply.status >= 400 ? "application/problem+json" : "application/json" });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
}

type Handler = (req: NextRequest) => Promise<Response>;
let lookupRoute: Handler;
let emailStartRoute: Handler;

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.APILENS_API_URL = `http://127.0.0.1:${port}`;
  process.env.SESSION_SECRET = "z".repeat(48);
  process.env.APILENS_PUBLIC_URL = PUBLIC_URL;
  lookupRoute = (await import("@/app/api/auth/sso/lookup/route")).POST;
  emailStartRoute = (await import("@/app/api/auth/email/start/route")).POST;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  replies = {};
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PUBLIC_URL, "x-forwarded-for": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/auth/sso/lookup", () => {
  it("answers the organization's SSO with next, remember and login_hint on the start URL", async () => {
    replies["GET /api/v1/auth/sso/lookup"] = () => ({
      status: 200,
      body: { sso: true, enforced: true, org_name: "Acme", start_url: START },
    });
    const res = await lookupRoute(post("/api/auth/sso/lookup", { email: "ada@acme.example.com", next: "/acme/requests" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, sso: true, enforced: true, org_name: "Acme" });
    const href = new URL(String(body.start_url));
    expect(href.origin + href.pathname).toBe(START);
    expect(Object.fromEntries(href.searchParams)).toEqual({
      next: "/acme/requests",
      remember: "true",
      login_hint: "ada@acme.example.com",
    });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].path, "http://x").searchParams.get("email")).toBe("ada@acme.example.com");
    expect(seen[0].headers["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("drops an off-origin next", async () => {
    replies["GET /api/v1/auth/sso/lookup"] = () => ({ status: 200, body: { sso: true, enforced: false, org_name: "Acme", start_url: START } });
    const res = await lookupRoute(post("/api/auth/sso/lookup", { email: "ada@acme.example.com", next: "//evil.example/x" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enforced).toBe(false);
    expect(new URL(String(body.start_url)).searchParams.has("next")).toBe(false);
  });

  it("answers sso: false when there is no SSO or the start URL is unusable", async () => {
    replies["GET /api/v1/auth/sso/lookup"] = () => ({ status: 200, body: { sso: false, enforced: false } });
    expect(await (await lookupRoute(post("/api/auth/sso/lookup", { email: "ada@example.com" }))).json()).toEqual({
      ok: true,
      sso: false,
      enforced: false,
    });
    replies["GET /api/v1/auth/sso/lookup"] = () => ({ status: 200, body: { sso: true, enforced: true, start_url: "javascript:alert(1)" } });
    expect(await (await lookupRoute(post("/api/auth/sso/lookup", { email: "ada@example.com" }))).json()).toMatchObject({ sso: false });
  });

  it("refuses a bad email without calling identity", async () => {
    const res = await lookupRoute(post("/api/auth/sso/lookup", { email: "nope" }));
    expect(res.status).toBe(422);
    expect(seen).toHaveLength(0);
  });

  it("refuses another origin", async () => {
    const res = await lookupRoute(post("/api/auth/sso/lookup", { email: "ada@example.com" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("passes identity's rate limit through", async () => {
    replies["GET /api/v1/auth/sso/lookup"] = () => ({ status: 429, body: { status: 429, title: "Too Many Requests", code: "rate_limited", retry_after: 30 } });
    const res = await lookupRoute(post("/api/auth/sso/lookup", { email: "ada@example.com" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, code: "rate_limited", retry_after: 30 });
  });
});

describe("POST /api/auth/email/start on an SSO-enforced domain", () => {
  it("answers 403 sso_required with the organization's start URL", async () => {
    replies["POST /api/v1/auth/email/start"] = () => ({
      status: 403,
      body: { status: 403, title: "Forbidden", code: "sso_required", start_url: START },
    });
    const res = await emailStartRoute(post("/api/auth/email/start", { email: "ada@acme.example.com", intent: "signin", next: "/acme" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, code: "sso_required" });
    const href = new URL(String(body.start_url));
    expect(Object.fromEntries(href.searchParams)).toEqual({ next: "/acme", remember: "true", login_hint: "ada@acme.example.com" });
  });

  it("omits an unusable start URL", async () => {
    replies["POST /api/v1/auth/email/start"] = () => ({ status: 403, body: { status: 403, code: "sso_required" } });
    const res = await emailStartRoute(post("/api/auth/email/start", { email: "ada@acme.example.com" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "sso_required" });
  });
});
