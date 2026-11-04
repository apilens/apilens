// Server-side refresh against a mocked identity server: a real HTTP server on a random port that
// APILENS_API_URL points at, so the coalescing is checked on the wire (count of POST /auth/refresh).
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PUBLIC_URL = "http://ui.apilens.test";
const SECRET = "s".repeat(48);
const OLD_ACCESS = "access-old";
const NEW_ACCESS = "access-new";
const NEW_REFRESH = "rt_new";

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}
type Reply = { status: number; body?: unknown; delayMs?: number };

let server: Server;
let seen: Seen[] = [];
let replies: Record<string, (req: Seen) => Reply> = {};

const USER = {
  id: "usr_1",
  email: "ada@example.com",
  email_verified: true,
  name: "Ada",
  avatar_url: null,
  preferences: {},
  onboarding: { step: null, completed: true },
  created_at: "2026-11-01T00:00:00Z",
};
const BUNDLE = { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 900, user: USER };
const REJECTED = { status: 401, body: { status: 401, title: "Unauthorized", code: "refresh_token_invalid" } };

function handle(req: IncomingMessage, res: ServerResponse) {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const entry: Seen = {
      method: req.method ?? "",
      path: req.url ?? "",
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    seen.push(entry);
    const reply = replies[`${entry.method} ${entry.path}`]?.(entry) ?? {
      status: 404,
      body: { status: 404, title: "Not Found", code: "not_found" },
    };
    setTimeout(() => {
      const json = reply.status >= 400 ? "application/problem+json" : "application/json";
      res.writeHead(reply.status, { "content-type": json });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    }, reply.delayMs ?? 0);
  });
}

let lib: typeof import("./server-session");
let session: typeof import("./session");
let gate: typeof import("./auth-gate");
let refreshRoute: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.APILENS_API_URL = `http://127.0.0.1:${port}`;
  process.env.SESSION_SECRET = SECRET;
  process.env.APILENS_PUBLIC_URL = PUBLIC_URL;
  lib = await import("./server-session");
  session = await import("./session");
  gate = await import("./auth-gate");
  refreshRoute = (await import("@/app/api/auth/refresh/route")).GET;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let tokenSeq = 0;
let refreshToken: string;

beforeEach(() => {
  seen = [];
  replies = {};
  lib.resetRefreshCache();
  // A distinct refresh token per test, so no test can hit another one's cache.
  refreshToken = `rt_old_${++tokenSeq}`;
});

const nowSeconds = () => Math.floor(Date.now() / 1000);
const refreshCalls = () => seen.filter((s) => s.path === "/api/v1/auth/refresh");

async function cookieFor(exp: number): Promise<string> {
  return session.seal({ access: OLD_ACCESS, refresh: refreshToken, exp, remember: true, uid: "usr_1" });
}

async function request(
  url: string,
  opts: { exp?: number; hint?: boolean; accept?: string; cookie?: string | null } = {},
): Promise<NextRequest> {
  const headers = new Headers({ "user-agent": "Mozilla/5.0 (Test)", "x-forwarded-for": "203.0.113.7" });
  const cookie = opts.cookie === undefined ? await cookieFor(opts.exp ?? nowSeconds() + 600) : opts.cookie;
  if (cookie !== null) headers.set("cookie", `${session.SESSION_COOKIE_NAME}=${cookie}`);
  if (opts.hint) headers.set(gate.REFRESH_HEADER, "1");
  if (opts.accept) headers.set("accept", opts.accept);
  return new NextRequest(`${PUBLIC_URL}${url}`, { headers });
}

/** A Route Handler that loads the current user through the session client. */
function meHandler(req: NextRequest) {
  return lib.withSession(req, async (s) => {
    const { identity } = await import("./identity");
    const user = await s.call((o) => identity().me(o));
    return NextResponse.json({ id: user.id });
  });
}

function sessionCookie(res: Response): string | undefined {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${session.SESSION_COOKIE_NAME}=`));
  return line?.slice(session.SESSION_COOKIE_NAME.length + 1).split(";")[0];
}

function meReply(req: Seen): Reply {
  return req.headers.authorization === `Bearer ${NEW_ACCESS}`
    ? { status: 200, body: USER }
    : { status: 401, body: { status: 401, title: "Unauthorized", code: "token_expired" } };
}

describe("refreshOnce", () => {
  it("makes one identity call for concurrent callers and reuses the result for 15 s", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE, delayMs: 30 });
    let now = 1_000_000;
    const deps = { now: () => now };
    const results = await Promise.all(Array.from({ length: 10 }, () => lib.refreshOnce(refreshToken, {}, deps)));
    expect(refreshCalls()).toHaveLength(1);
    expect(refreshCalls()[0].body).toEqual({ refresh_token: refreshToken });
    for (const r of results) expect(r.access_token).toBe(NEW_ACCESS);

    now += lib.RECENT_REFRESH_TTL_MS - 1;
    await lib.refreshOnce(refreshToken, {}, deps);
    expect(refreshCalls()).toHaveLength(1);

    now += 1;
    await lib.refreshOnce(refreshToken, {}, deps);
    expect(refreshCalls()).toHaveLength(2);
  });

  it("keys by token: different tokens refresh independently", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE, delayMs: 10 });
    await Promise.all([lib.refreshOnce(`${refreshToken}-a`), lib.refreshOnce(`${refreshToken}-b`)]);
    expect(refreshCalls()).toHaveLength(2);
  });

  it("shares a failure with concurrent callers but does not cache it", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ ...REJECTED, delayMs: 20 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => lib.refreshOnce(refreshToken)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(refreshCalls()).toHaveLength(1);
    await expect(lib.refreshOnce(refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls()).toHaveLength(2);
  });

  it("never uses the raw token as a key", () => {
    expect(lib.refreshKey("rt_secret")).not.toContain("rt_secret");
    expect(lib.refreshKey("rt_secret")).toBe(lib.refreshKey("rt_secret"));
  });
});

describe("Route Handler session", () => {
  it("10 parallel requests flagged by the proxy cause exactly 1 refresh and all get the new cookie", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE, delayMs: 30 });
    replies["GET /api/v1/users/me"] = meReply;
    const reqs = await Promise.all(Array.from({ length: 10 }, () => request("/api/things", { hint: true })));
    const responses = await Promise.all(reqs.map(meHandler));

    expect(refreshCalls()).toHaveLength(1);
    expect(refreshCalls()[0].headers["x-forwarded-for"]).toBe("203.0.113.7");
    for (const res of responses) {
      expect(res.status).toBe(200);
      const opened = await session.open(sessionCookie(res));
      expect(opened).toMatchObject({ access: NEW_ACCESS, refresh: NEW_REFRESH, remember: true, uid: "usr_1" });
      expect(opened!.exp).toBeGreaterThanOrEqual(nowSeconds() + 899);
      const line = res.headers.getSetCookie()[0];
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/Max-Age=2592000/);
    }
    const meCalls = seen.filter((s) => s.path === "/api/v1/users/me");
    expect(meCalls).toHaveLength(10);
    for (const c of meCalls) expect(c.headers.authorization).toBe(`Bearer ${NEW_ACCESS}`);
  });

  it("refreshes an expired token without the proxy hint", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE });
    replies["GET /api/v1/users/me"] = meReply;
    const res = await meHandler(await request("/api/things", { exp: nowSeconds() - 5 }));
    expect(res.status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);
  });

  it("does not refresh or rewrite the cookie while the token is fresh", async () => {
    replies["GET /api/v1/users/me"] = () => ({ status: 200, body: USER });
    const res = await meHandler(await request("/api/things"));
    expect(res.status).toBe(200);
    expect(refreshCalls()).toHaveLength(0);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("10 parallel 401s from the backend cause 1 refresh, then each call is retried", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE, delayMs: 30 });
    replies["GET /api/v1/users/me"] = meReply;
    const reqs = await Promise.all(Array.from({ length: 10 }, () => request("/api/things")));
    const responses = await Promise.all(reqs.map(meHandler));
    expect(refreshCalls()).toHaveLength(1);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect((await session.open(sessionCookie(res)))?.access).toBe(NEW_ACCESS);
    }
  });

  it("keeps the current token when identity is down and the token is still valid", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 503, body: { status: 503, title: "Unavailable" } });
    replies["GET /api/v1/users/me"] = () => ({ status: 200, body: USER });
    const res = await meHandler(await request("/api/things", { hint: true }));
    expect(res.status).toBe(200);
    expect(seen.find((s) => s.path === "/api/v1/users/me")?.headers.authorization).toBe(`Bearer ${OLD_ACCESS}`);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("refresh failure", () => {
  it("clears the cookie and answers 401 session_expired to a fetch; 10 parallel → 1 refresh", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ ...REJECTED, delayMs: 30 });
    const reqs = await Promise.all(Array.from({ length: 10 }, () => request("/api/things", { hint: true })));
    const responses = await Promise.all(reqs.map(meHandler));
    expect(refreshCalls()).toHaveLength(1);
    expect(seen.filter((s) => s.path === "/api/v1/users/me")).toHaveLength(0);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, code: "session_expired", next: "/sign-in?reason=session_expired" });
      expect(sessionCookie(res)).toBe("");
      expect(res.headers.getSetCookie()[0]).toMatch(/Max-Age=0/);
    }
  });

  it("redirects a navigation to /sign-in?reason=session_expired", async () => {
    replies["POST /api/v1/auth/refresh"] = () => REJECTED;
    const res = await meHandler(await request("/api/things", { exp: nowSeconds() - 1, accept: "text/html" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${PUBLIC_URL}/sign-in?reason=session_expired`);
    expect(sessionCookie(res)).toBe("");
  });

  it("retries a 401 only once: a second 401 surfaces without another refresh", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE });
    replies["GET /api/v1/users/me"] = () => ({ status: 401, body: { status: 401, title: "Unauthorized" } });
    await expect(meHandler(await request("/api/things"))).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls()).toHaveLength(1);
    expect(seen.filter((s) => s.path === "/api/v1/users/me")).toHaveLength(2);
  });

  it("treats a missing cookie as expired", async () => {
    const res = await meHandler(await request("/api/things", { cookie: null }));
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("surfaces a transient failure when the token has already expired, keeping the cookie", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 503, body: { status: 503, title: "Unavailable" } });
    await expect(meHandler(await request("/api/things", { exp: nowSeconds() - 1 }))).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("read-only session (Server Components)", () => {
  async function readOnly(exp: number, hint = true) {
    const req = await request("/acme/endpoints", { exp, hint });
    const payload = await session.open(req.cookies.get(session.SESSION_COOKIE_NAME)?.value);
    return new lib.ServerSession({ session: payload, headers: req.headers, canWrite: false });
  }

  it("uses a still-valid token despite the hint and never refreshes", async () => {
    const s = await readOnly(nowSeconds() + 60);
    expect(await s.accessToken()).toBe(OLD_ACCESS);
    expect(refreshCalls()).toHaveLength(0);
  });

  it("throws SessionExpiredError on an expired token instead of refreshing", async () => {
    const s = await readOnly(nowSeconds() - 1);
    await expect(s.accessToken()).rejects.toBeInstanceOf(lib.SessionExpiredError);
    expect(refreshCalls()).toHaveLength(0);
  });

  it("points at the refresh route with a safe next", () => {
    expect(lib.refreshUrl("/acme/endpoints?env=prod")).toBe("/api/auth/refresh?next=%2Facme%2Fendpoints%3Fenv%3Dprod");
    expect(lib.refreshUrl("//evil.example")).toBe("/api/auth/refresh?next=%2F");
  });
});

describe("Server Action session", () => {
  it("persists the refreshed cookie through the writer, and clears it on failure", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE });
    const changes: import("./server-session").CookieChange[] = [];
    const req = await request("/", { hint: true });
    const payload = await session.open(req.cookies.get(session.SESSION_COOKIE_NAME)?.value);
    const s = new lib.ServerSession({ session: payload, headers: req.headers, canWrite: true, onChange: (c) => void changes.push(c) });
    expect(await s.accessToken()).toBe(NEW_ACCESS);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("set");

    lib.resetRefreshCache();
    replies["POST /api/v1/auth/refresh"] = () => REJECTED;
    await expect(s.refresh()).rejects.toBeInstanceOf(lib.SessionExpiredError);
    expect(changes.at(-1)).toEqual({ kind: "clear" });
    expect(s.payload).toBeNull();
  });
});

describe("GET /api/auth/refresh", () => {
  it("refreshes, rewrites the cookie and returns to next", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE });
    const res = await refreshRoute(await request("/api/auth/refresh?next=%2Facme%2Fendpoints", { exp: nowSeconds() - 1 }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${PUBLIC_URL}/acme/endpoints`);
    expect((await session.open(sessionCookie(res)))?.access).toBe(NEW_ACCESS);
  });

  it("never redirects off-origin", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: BUNDLE });
    const res = await refreshRoute(await request("/api/auth/refresh?next=%2F%2Fevil.example"));
    expect(res.headers.get("location")).toBe(`${PUBLIC_URL}/`);
  });

  it("clears the cookie and redirects to sign-in when the refresh token is rejected", async () => {
    replies["POST /api/v1/auth/refresh"] = () => REJECTED;
    const res = await refreshRoute(await request("/api/auth/refresh?next=%2Facme"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${PUBLIC_URL}/sign-in?reason=session_expired`);
    expect(sessionCookie(res)).toBe("");
  });

  it("answers 503 and keeps the cookie when identity is unavailable", async () => {
    replies["POST /api/v1/auth/refresh"] = () => ({ status: 503, body: { status: 503, title: "Unavailable" } });
    const res = await refreshRoute(await request("/api/auth/refresh?next=%2Facme"));
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
