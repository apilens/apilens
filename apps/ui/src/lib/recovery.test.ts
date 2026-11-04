// Server tests for account recovery (#321): the state the status and cancel pages render
// (`recoveryView`) and the `POST /api/auth/recovery/{request,confirm,cancel}` Route Handlers,
// against a mocked identity server (a real HTTP server on a random port that APILENS_API_URL
// points at). Addresses are @example.com only.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "./identity";

const PUBLIC_URL = "http://ui.apilens.test";
const ACCESS = "eyJhbGciOiJSUzI1NiJ9.ACCESS-TOKEN-SECRET.sig";
const REFRESH = "rt_REFRESH-TOKEN-SECRET";
const TOKEN = "rcv_TOKEN-abc_xyz-0123456789abcdefghijklmnopqrstu";
const NOW = Date.parse("2026-11-04T12:00:00Z");

const USER: User = {
  id: "usr_1",
  email: "ada@example.com",
  email_verified: true,
  name: "Ada",
  avatar_url: null,
  preferences: {},
  onboarding: { step: null, completed: true },
  created_at: "2026-11-01T00:00:00Z",
  amr: ["email"],
};
const BUNDLE = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 900, user: USER };

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

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
    const route = `${entry.method} ${entry.path.split("?")[0]}`;
    const reply = replies[route]?.(entry) ?? { status: 404, body: { status: 404, title: "Not Found", code: "not_found" } };
    res.writeHead(reply.status, {
      "content-type": reply.status >= 400 ? "application/problem+json" : "application/json",
      ...reply.headers,
    });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
}

type Handler = (req: NextRequest) => Promise<Response>;
let rec: typeof import("./recovery");
let session: typeof import("./session");
let routes: typeof import("./auth-routes");
let handlers: Record<"request" | "confirm" | "cancel", Handler>;

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.APILENS_API_URL = `http://127.0.0.1:${port}`;
  process.env.SESSION_SECRET = "z".repeat(48);
  process.env.APILENS_PUBLIC_URL = PUBLIC_URL;
  rec = await import("./recovery");
  session = await import("./session");
  routes = await import("./auth-routes");
  handlers = {
    request: (await import("@/app/api/auth/recovery/request/route")).POST,
    confirm: (await import("@/app/api/auth/recovery/confirm/route")).POST,
    cancel: (await import("@/app/api/auth/recovery/cancel/route")).POST,
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  replies = {};
});

const problem =
  (status: number, code: string, retryAfter?: number) =>
  (): Reply => ({
    status,
    body: { status, title: code, code, ...(retryAfter ? { retry_after: retryAfter } : {}) },
    headers: retryAfter ? { "retry-after": String(retryAfter) } : undefined,
  });

const statusReply = (status: string, readyAt = "2026-11-05T11:00:00Z") => (): Reply => ({
  status: 200,
  body: { status, requested_at: "2026-11-04T11:00:00Z", ready_at: readyAt },
});

const view = (token: unknown) =>
  rec.recoveryView(token, { now: NOW, context: { forwardedFor: "203.0.113.7", userAgent: "Mozilla/5.0 (Test)" } });

describe("recoveryView (status and cancel pages)", () => {
  it("pending: counts down to ready_at, forwarding the browser context", async () => {
    replies["GET /api/v1/auth/recovery/status"] = statusReply("pending");
    expect(await view(TOKEN)).toEqual({
      kind: "pending",
      token: TOKEN,
      requestedAt: "Nov 4, 2026, 11:00 UTC",
      readyAt: "Nov 5, 2026, 11:00 UTC",
      secondsLeft: 23 * 3600,
    });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].path, "http://x").searchParams.get("token")).toBe(TOKEN);
    expect(seen[0].headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(seen[0].headers["user-agent"]).toBe("Mozilla/5.0 (Test)");
  });

  it("ready: identity says the cooling-off period is over", async () => {
    replies["GET /api/v1/auth/recovery/status"] = statusReply("ready", "2026-11-04T11:30:00Z");
    expect(await view(TOKEN)).toEqual({
      kind: "ready",
      token: TOKEN,
      requestedAt: "Nov 4, 2026, 11:00 UTC",
      readyAt: "Nov 4, 2026, 11:30 UTC",
    });
  });

  it("ready: a pending answer whose ready_at has already passed", async () => {
    replies["GET /api/v1/auth/recovery/status"] = statusReply("pending", "2026-11-04T11:59:59Z");
    expect((await view(TOKEN)).kind).toBe("ready");
  });

  it("confirmed: the link is spent", async () => {
    replies["GET /api/v1/auth/recovery/status"] = statusReply("confirmed");
    expect(await view(TOKEN)).toEqual({ kind: "confirmed", requestedAt: "Nov 4, 2026, 11:00 UTC" });
  });

  it("cancelled: cancelled or replaced by a newer request", async () => {
    replies["GET /api/v1/auth/recovery/status"] = statusReply("cancelled");
    expect(await view(TOKEN)).toEqual({ kind: "cancelled", requestedAt: "Nov 4, 2026, 11:00 UTC" });
  });

  it("invalid: identity does not know the token", async () => {
    replies["GET /api/v1/auth/recovery/status"] = problem(401, "invalid_token");
    expect(await view(TOKEN)).toEqual({ kind: "invalid" });
  });

  it("invalid: a missing, blank or oversized token never calls identity", async () => {
    expect(await view(undefined)).toEqual({ kind: "invalid" });
    expect(await view("  ")).toEqual({ kind: "invalid" });
    expect(await view("x".repeat(129))).toEqual({ kind: "invalid" });
    expect(seen).toHaveLength(0);
  });

  it("takes the first of a repeated ?token=", async () => {
    replies["GET /api/v1/auth/recovery/status"] = statusReply("ready");
    expect((await view([TOKEN, "other"])).kind).toBe("ready");
    expect(new URL(seen[0].path, "http://x").searchParams.get("token")).toBe(TOKEN);
  });

  it("rate_limited: carries identity's Retry-After", async () => {
    replies["GET /api/v1/auth/recovery/status"] = problem(429, "rate_limited", 42);
    expect(await view(TOKEN)).toEqual({ kind: "rate_limited", retryAfter: 42 });
  });

  it("error: identity failed or is unreachable", async () => {
    replies["GET /api/v1/auth/recovery/status"] = problem(500, "internal_error");
    expect(await view(TOKEN)).toEqual({ kind: "error" });
    const down = await rec.recoveryView(TOKEN, {
      client: (await import("./identity")).createClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
    });
    expect(down).toEqual({ kind: "error" });
  });

  it("error: an unexpected status value", async () => {
    replies["GET /api/v1/auth/recovery/status"] = statusReply("exploded");
    expect(await view(TOKEN)).toEqual({ kind: "error" });
  });
});

async function post(route: keyof typeof handlers, body: unknown, headers: Record<string, string> = {}) {
  const req = new NextRequest(`${PUBLIC_URL}/api/auth/recovery/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: PUBLIC_URL,
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "Mozilla/5.0 (Test)",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handlers[route](req);
  const text = await res.text();
  return { res, text, json: JSON.parse(text) as Record<string, unknown>, setCookies: res.headers.getSetCookie() };
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  return setCookies.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(";")[0];
}

describe("POST /api/auth/recovery/request", () => {
  it("sent: always the same answer, with the browser context forwarded", async () => {
    replies["POST /api/v1/auth/recovery/request"] = () => ({ status: 200, body: { sent: true } });
    const { res, json, setCookies } = await post("request", { email: "ada@example.com" });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, next: "/auth/recovery" });
    expect(seen[0].body).toEqual({ email: "ada@example.com" });
    expect(seen[0].headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(setCookies).toEqual([]);
  });

  it("an address without an account answers exactly like one with", async () => {
    replies["POST /api/v1/auth/recovery/request"] = () => ({ status: 200, body: { sent: true } });
    const known = await post("request", { email: "ada@example.com" });
    const unknown = await post("request", { email: "nobody@example.com" });
    expect(unknown.text).toBe(known.text);
  });

  it("refuses a malformed address without calling identity", async () => {
    const { res, json } = await post("request", { email: "not-an-email" });
    expect(res.status).toBe(422);
    expect(json).toEqual({ ok: false, code: "validation_failed" });
    expect(seen).toHaveLength(0);
  });

  it("rate_limited: passes the wait through", async () => {
    replies["POST /api/v1/auth/recovery/request"] = problem(429, "rate_limited", 300);
    const { res, json } = await post("request", { email: "ada@example.com" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("300");
    expect(json).toEqual({ ok: false, code: "rate_limited", retry_after: 300 });
  });

  it("refuses a cross-origin post", async () => {
    const { res } = await post("request", { email: "ada@example.com" }, { origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe("POST /api/auth/recovery/confirm", () => {
  it("ready: seals the recovered session (24-hour cookie) and lands on /", async () => {
    replies["POST /api/v1/auth/recovery/confirm"] = () => ({ status: 200, body: BUNDLE });
    const { res, json, text, setCookies } = await post("confirm", { token: TOKEN });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, next: "/" });
    expect(seen[0].body).toEqual({ token: TOKEN });

    const sealed = cookieValue(setCookies, session.SESSION_COOKIE_NAME);
    expect(await session.open(sealed)).toMatchObject({ access: ACCESS, refresh: REFRESH, remember: false, uid: "usr_1" });
    const cookie = setCookies.find((c) => c.startsWith(`${session.SESSION_COOKIE_NAME}=`)) ?? "";
    expect(cookie.toLowerCase()).toContain("httponly");
    // A pending 2FA sign-in from before is dropped.
    expect(cookieValue(setCookies, routes.PRE_AUTH_COOKIE_NAME)).toBe("");
    for (const secret of [ACCESS, REFRESH]) expect(text).not.toContain(secret);
  });

  it("pending: recovery_not_ready with the seconds left", async () => {
    replies["POST /api/v1/auth/recovery/confirm"] = problem(409, "recovery_not_ready", 3600);
    const { res, json, setCookies } = await post("confirm", { token: TOKEN });
    expect(res.status).toBe(409);
    expect(json).toEqual({ ok: false, code: "recovery_not_ready", retry_after: 3600 });
    expect(setCookies).toEqual([]);
  });

  it("cancelled or used: invalid_token, no cookie", async () => {
    replies["POST /api/v1/auth/recovery/confirm"] = problem(401, "invalid_token");
    const { res, json, setCookies } = await post("confirm", { token: TOKEN });
    expect(res.status).toBe(401);
    expect(json).toEqual({ ok: false, code: "invalid_token" });
    expect(setCookies).toEqual([]);
  });

  it("refuses a missing or oversized token without calling identity", async () => {
    expect((await post("confirm", {})).res.status).toBe(422);
    expect((await post("confirm", { token: "x".repeat(129) })).res.status).toBe(422);
    expect(seen).toHaveLength(0);
  });
});

describe("POST /api/auth/recovery/cancel", () => {
  it("pending: cancels and points back at sign in", async () => {
    replies["POST /api/v1/auth/recovery/cancel"] = () => ({ status: 204 });
    const { res, json, setCookies } = await post("cancel", { token: TOKEN });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, next: "/sign-in" });
    expect(seen[0].body).toEqual({ token: TOKEN });
    expect(setCookies).toEqual([]);
  });

  it("confirmed or unknown: invalid_token", async () => {
    replies["POST /api/v1/auth/recovery/cancel"] = problem(401, "invalid_token");
    const { res, json } = await post("cancel", { token: TOKEN });
    expect(res.status).toBe(401);
    expect(json).toEqual({ ok: false, code: "invalid_token" });
  });

  it("identity down: a gateway error, not a false success", async () => {
    replies["POST /api/v1/auth/recovery/cancel"] = problem(503, "unavailable");
    const { res, json } = await post("cancel", { token: TOKEN });
    expect(res.status).toBe(503);
    expect(json.ok).toBe(false);
  });
});
