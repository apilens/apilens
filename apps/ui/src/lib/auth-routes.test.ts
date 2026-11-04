// Integration tests for the `/api/auth/*` Route Handlers against a mocked identity server: a real
// HTTP server on a random port that APILENS_API_URL points at, so the handlers exercise the whole
// path (validation, identity client, cookie sealing) with no stubbed fetch.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PUBLIC_URL = "http://ui.apilens.test";
const SECRET = "x".repeat(48);
const ACCESS = "eyJhbGciOiJSUzI1NiJ9.ACCESS-TOKEN-SECRET.sig";
const REFRESH = "rt_REFRESH-TOKEN-SECRET";
const PRE_AUTH = "pat_PRE-AUTH-TOKEN-SECRET";
const TOKENS = [ACCESS, REFRESH, PRE_AUTH];

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
const BUNDLE = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 900, user: USER, next: null };

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
    const json = reply.status >= 400 ? "application/problem+json" : "application/json";
    res.writeHead(reply.status, { "content-type": json, ...reply.headers });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
}

type Handler = (req: NextRequest) => Promise<Response>;
let routes: Record<string, Handler>;
let session: typeof import("./session");
let lib: typeof import("./auth-routes");

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.APILENS_API_URL = `http://127.0.0.1:${port}`;
  process.env.SESSION_SECRET = SECRET;
  process.env.APILENS_PUBLIC_URL = PUBLIC_URL;

  session = await import("./session");
  lib = await import("./auth-routes");
  routes = {
    "email/start": (await import("@/app/api/auth/email/start/route")).POST,
    "email/verify": (await import("@/app/api/auth/email/verify/route")).POST,
    "email/verify-link": (await import("@/app/api/auth/email/verify-link/route")).POST,
    handoff: (await import("@/app/api/auth/handoff/route")).POST,
    "2fa/exchange": (await import("@/app/api/auth/2fa/exchange/route")).POST,
    "passkeys/login/options": (await import("@/app/api/auth/passkeys/login/options/route")).POST,
    "passkeys/login/verify": (await import("@/app/api/auth/passkeys/login/verify/route")).POST,
    logout: (await import("@/app/api/auth/logout/route")).POST,
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  replies = {};
});

const BROWSER_HEADERS = {
  "content-type": "application/json",
  origin: PUBLIC_URL,
  "user-agent": "Mozilla/5.0 (Test) Firefox/140",
  "x-forwarded-for": "203.0.113.7, 10.0.0.1",
};

interface CallInit {
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

async function call(route: string, init: CallInit = {}) {
  const headers = new Headers({ ...BROWSER_HEADERS, ...init.headers });
  if (init.cookies) {
    headers.set(
      "cookie",
      Object.entries(init.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  const req = new NextRequest(`${PUBLIC_URL}/api/auth/${route}`, {
    method: "POST",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  const res = await routes[route](req);
  const text = await res.text();
  return { res, text, json: JSON.parse(text) as Record<string, unknown>, setCookies: res.headers.getSetCookie() };
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  const line = setCookies.find((c) => c.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(";")[0];
}

function cookieLine(setCookies: string[], name: string): string {
  const line = setCookies.find((c) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`no Set-Cookie for ${name}: ${setCookies.join(" | ")}`);
  return line;
}

function expectNoTokens(text: string) {
  for (const token of TOKENS) expect(text).not.toContain(token);
}

describe("POST /api/auth/email/start", () => {
  it("forwards input and browser headers, answers with the verify page", async () => {
    replies["POST /api/v1/auth/email/start"] = () => ({ status: 200, body: { sent: true, retry_after: 30 } });
    const { res, json } = await call("email/start", {
      body: { email: "ada@example.com", intent: "signup", next: "/acme/endpoints", remember: true },
    });
    expect(res.status).toBe(200);
    expect(json).toEqual({
      ok: true,
      next: "/verify?flow=signup&email=ada%40example.com&next=%2Facme%2Fendpoints",
      retry_after: 30,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ email: "ada@example.com", intent: "signup", next: "/acme/endpoints", remember: true });
    expect(seen[0].headers["x-forwarded-for"]).toBe("203.0.113.7, 10.0.0.1");
    expect(seen[0].headers["user-agent"]).toBe("Mozilla/5.0 (Test) Firefox/140");
    expect(seen[0].headers["x-request-id"]).toBeTruthy();
  });

  it("drops an off-origin next instead of forwarding it", async () => {
    replies["POST /api/v1/auth/email/start"] = () => ({ status: 200, body: { sent: true, retry_after: 30 } });
    const { json } = await call("email/start", { body: { email: "ada@example.com", next: "//evil.example" } });
    expect(json.next).toBe("/verify?flow=signin&email=ada%40example.com");
    expect((seen[0].body as Record<string, unknown>).next).toBeUndefined();
  });

  it.each([
    [{}, 422, "validation_failed"],
    [{ email: "not-an-email" }, 422, "validation_failed"],
    [{ email: "ada@example.com", intent: "admin" }, 422, "validation_failed"],
    [{ email: "ada@example.com", remember: "yes" }, 422, "validation_failed"],
    ["[1,2]", 400, "bad_request"],
    ["{nope", 400, "bad_request"],
  ])("rejects bad input %j without calling identity", async (body, status, code) => {
    const { res, json } = await call("email/start", { body });
    expect(res.status).toBe(status);
    expect(json).toEqual({ ok: false, code });
    expect(seen).toHaveLength(0);
  });

  it("requires a JSON content type", async () => {
    const { res, json } = await call("email/start", {
      body: "email=ada@example.com",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(415);
    expect(json).toEqual({ ok: false, code: "unsupported_media_type" });
  });

  it("rejects a cross-origin caller", async () => {
    const { res, json } = await call("email/start", {
      body: { email: "ada@example.com" },
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(json).toEqual({ ok: false, code: "forbidden" });
    expect(seen).toHaveLength(0);
  });

  it("passes identity's problem code and Retry-After through", async () => {
    replies["POST /api/v1/auth/email/start"] = () => ({
      status: 429,
      body: { status: 429, title: "Too Many Requests", detail: "slow down", code: "rate_limited" },
      headers: { "retry-after": "42" },
    });
    const { res, json } = await call("email/start", { body: { email: "ada@example.com" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(json).toEqual({ ok: false, code: "rate_limited", retry_after: 42 });
  });
});

describe("POST /api/auth/email/verify", () => {
  it("seals the session into an httpOnly cookie and returns only {ok, next}", async () => {
    replies["POST /api/v1/auth/email/verify"] = () => ({ status: 200, body: BUNDLE });
    const before = Math.floor(Date.now() / 1000);
    const { res, text, json, setCookies } = await call("email/verify", {
      body: { email: "ada@example.com", code: "123456", remember: true, next: "/acme/requests" },
    });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, next: "/acme/requests" });
    expectNoTokens(text);
    expect(seen[0].body).toEqual({ email: "ada@example.com", code: "123456", remember: true });
    expect(seen[0].headers["x-forwarded-for"]).toBe("203.0.113.7, 10.0.0.1");

    const line = cookieLine(setCookies, session.SESSION_COOKIE_NAME);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=lax/i);
    expect(line).toMatch(/Path=\//);
    expect(line).toMatch(/Max-Age=2592000/);
    expect(line).not.toMatch(/Secure/i); // public URL is http
    expectNoTokens(line);

    const opened = await session.open(cookieValue(setCookies, session.SESSION_COOKIE_NAME), SECRET);
    expect(opened).toMatchObject({ access: ACCESS, refresh: REFRESH, remember: true, uid: "usr_1" });
    expect(opened?.exp).toBeGreaterThanOrEqual(before + 900);
    expect(opened?.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
  });

  it("uses a 24h cookie without remember, and identity's stored next when none is given", async () => {
    replies["POST /api/v1/auth/email/verify"] = () => ({ status: 200, body: { ...BUNDLE, next: "/acme/exceptions" } });
    const { json, setCookies } = await call("email/verify", { body: { email: "ada@example.com", code: "123456" } });
    expect(json).toEqual({ ok: true, next: "/acme/exceptions" });
    expect(cookieLine(setCookies, session.SESSION_COOKIE_NAME)).toMatch(/Max-Age=86400/);
  });

  it("never follows an off-origin next from identity", async () => {
    replies["POST /api/v1/auth/email/verify"] = () => ({ status: 200, body: { ...BUNDLE, next: "https://evil.example" } });
    const { json } = await call("email/verify", { body: { email: "ada@example.com", code: "123456" } });
    expect(json).toEqual({ ok: true, next: "/" });
  });

  it("maps a wrong code to its problem code and sets no cookie", async () => {
    replies["POST /api/v1/auth/email/verify"] = () => ({
      status: 401,
      body: { status: 401, title: "Unauthorized", code: "invalid_code" },
    });
    const { res, json, setCookies } = await call("email/verify", { body: { email: "ada@example.com", code: "000000" } });
    expect(res.status).toBe(401);
    expect(json).toEqual({ ok: false, code: "invalid_code" });
    expect(setCookies).toEqual([]);
  });
});

describe("2FA", () => {
  it("parks the pre-auth token in an httpOnly cookie, then exchanges it for a session", async () => {
    replies["POST /api/v1/auth/email/verify-link"] = () => ({
      status: 200,
      body: { status: "2fa_required", pre_auth_token: PRE_AUTH, next: "/acme/endpoints" },
    });
    const first = await call("email/verify-link", { body: { token: "mlt_abc", remember: true } });
    expect(first.res.status).toBe(200);
    expect(first.json).toEqual({ ok: false, code: "2fa_required", next: "/acme/endpoints" });
    expectNoTokens(first.text);
    expect(cookieValue(first.setCookies, session.SESSION_COOKIE_NAME)).toBeUndefined();
    const preLine = cookieLine(first.setCookies, lib.PRE_AUTH_COOKIE_NAME);
    expect(preLine).toMatch(/HttpOnly/i);
    expect(preLine).toMatch(/Path=\/api\/auth\/2fa/);
    expect(preLine).toMatch(/Max-Age=300/);

    replies["POST /api/v1/auth/2fa/exchange"] = () => ({ status: 200, body: BUNDLE });
    const second = await call("2fa/exchange", {
      body: { code: "654321" },
      cookies: { [lib.PRE_AUTH_COOKIE_NAME]: cookieValue(first.setCookies, lib.PRE_AUTH_COOKIE_NAME) as string },
    });
    expect(second.res.status).toBe(200);
    expect(second.json).toEqual({ ok: true, next: "/acme/endpoints" });
    expectNoTokens(second.text);
    expect(seen.at(-1)?.body).toEqual({ pre_auth_token: PRE_AUTH, code: "654321" });
    expect(seen.at(-1)?.headers["user-agent"]).toBe("Mozilla/5.0 (Test) Firefox/140");

    const opened = await session.open(cookieValue(second.setCookies, session.SESSION_COOKIE_NAME), SECRET);
    expect(opened).toMatchObject({ access: ACCESS, refresh: REFRESH, remember: true });
    expect(cookieLine(second.setCookies, lib.PRE_AUTH_COOKIE_NAME)).toMatch(/Max-Age=0/);
  });

  it.each([
    [true, 2_592_000],
    [false, 86_400],
  ])("carries remember=%s from the first factor to a %i-second session cookie", async (remember, maxAge) => {
    replies["POST /api/v1/auth/email/verify"] = () => ({
      status: 200,
      body: { status: "2fa_required", pre_auth_token: PRE_AUTH, next: "/acme/endpoints" },
    });
    const first = await call("email/verify", { body: { email: "ada@example.com", code: "123456", remember } });
    expect(seen[0].body).toEqual({ email: "ada@example.com", code: "123456", remember });

    replies["POST /api/v1/auth/2fa/exchange"] = () => ({ status: 200, body: BUNDLE });
    const second = await call("2fa/exchange", {
      body: { code: "654321" },
      cookies: { [lib.PRE_AUTH_COOKIE_NAME]: cookieValue(first.setCookies, lib.PRE_AUTH_COOKIE_NAME) as string },
    });
    expect(second.json).toEqual({ ok: true, next: "/acme/endpoints" });
    expect(cookieLine(second.setCookies, session.SESSION_COOKIE_NAME)).toMatch(new RegExp(`Max-Age=${maxAge}(;|$)`));
    const opened = await session.open(cookieValue(second.setCookies, session.SESSION_COOKIE_NAME), SECRET);
    expect(opened).toMatchObject({ remember });
  });

  it("accepts a backup code", async () => {
    replies["POST /api/v1/auth/2fa/exchange"] = () => ({ status: 200, body: BUNDLE });
    const pre = Buffer.from(JSON.stringify({ t: PRE_AUTH, r: false, n: "/" })).toString("base64url");
    const { json } = await call("2fa/exchange", {
      body: { backup_code: "abcd-efgh" },
      cookies: { [lib.PRE_AUTH_COOKIE_NAME]: pre },
    });
    expect(json).toEqual({ ok: true, next: "/" });
    expect(seen[0].body).toEqual({ pre_auth_token: PRE_AUTH, backup_code: "abcd-efgh" });
  });

  it("refuses an exchange without a pending sign-in", async () => {
    const { res, json } = await call("2fa/exchange", { body: { code: "654321" } });
    expect(res.status).toBe(401);
    expect(json).toEqual({ ok: false, code: "2fa_session_expired" });
    expect(seen).toHaveLength(0);
  });

  it("needs exactly one of code and backup_code", async () => {
    const { res } = await call("2fa/exchange", { body: { code: "1", backup_code: "2" } });
    expect(res.status).toBe(422);
  });
});

describe("POST /api/auth/handoff", () => {
  it("redeems the OAuth handoff code", async () => {
    replies["POST /api/v1/auth/handoff"] = () => ({ status: 200, body: BUNDLE });
    const { json, text, setCookies } = await call("handoff", { body: { code: "hof_1", next: "/acme/requests" } });
    expect(json).toEqual({ ok: true, next: "/acme/requests" });
    expectNoTokens(text);
    expect(seen[0].body).toEqual({ code: "hof_1" });
    expect(cookieValue(setCookies, session.SESSION_COOKIE_NAME)).toBeTruthy();
  });
});

describe("passkeys", () => {
  it("returns the WebAuthn options", async () => {
    const options = { publicKey: { challenge: "Y2hhbA", rpId: "apilens.test" } };
    replies["POST /api/v1/auth/passkeys/login/options"] = () => ({
      status: 200,
      body: { challenge_id: "ch_1", options },
    });
    const { json } = await call("passkeys/login/options", { body: {} });
    expect(json).toEqual({ ok: true, next: "/sign-in", challenge_id: "ch_1", options });
    expect(seen[0].body).toEqual({});
  });

  it("verifies the assertion and sets the session", async () => {
    replies["POST /api/v1/auth/passkeys/login/verify"] = () => ({ status: 200, body: BUNDLE });
    const credential = { id: "cred", response: { signature: "c2ln" }, type: "public-key" };
    const { json, text, setCookies } = await call("passkeys/login/verify", {
      body: { challenge_id: "ch_1", credential, remember: true },
    });
    expect(json).toEqual({ ok: true, next: "/" });
    expectNoTokens(text);
    expect(seen[0].body).toEqual({ challenge_id: "ch_1", credential, remember: true });
    expect(await session.open(cookieValue(setCookies, session.SESSION_COOKIE_NAME), SECRET)).toMatchObject({
      uid: "usr_1",
    });
  });

  it("rejects a missing credential", async () => {
    const { res } = await call("passkeys/login/verify", { body: { challenge_id: "ch_1" } });
    expect(res.status).toBe(422);
    expect(seen).toHaveLength(0);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the refresh token at identity and clears the cookie", async () => {
    replies["POST /api/v1/auth/logout"] = () => ({ status: 204 });
    const cookie = await session.seal(
      { access: ACCESS, refresh: REFRESH, exp: 2_000_000_000, remember: true, uid: "usr_1" },
      SECRET,
    );
    const { res, json, text, setCookies } = await call("logout", {
      cookies: { [session.SESSION_COOKIE_NAME]: cookie },
      headers: { "content-type": "" },
    });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, next: "/sign-in?reason=signed_out" });
    expectNoTokens(text);
    expect(seen[0].body).toEqual({ refresh_token: REFRESH });
    expect(seen[0].headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(seen[0].headers["x-forwarded-for"]).toBe("203.0.113.7, 10.0.0.1");
    expect(cookieLine(setCookies, session.SESSION_COOKIE_NAME)).toMatch(/Max-Age=0/);
  });

  it("still clears the cookie when identity fails", async () => {
    replies["POST /api/v1/auth/logout"] = () => ({ status: 503, body: { status: 503, title: "Unavailable" } });
    const cookie = await session.seal(
      { access: ACCESS, refresh: REFRESH, exp: 2_000_000_000, remember: false, uid: "usr_1" },
      SECRET,
    );
    const { json, setCookies } = await call("logout", { cookies: { [session.SESSION_COOKIE_NAME]: cookie } });
    expect(json).toEqual({ ok: true, next: "/sign-in?reason=signed_out" });
    expect(cookieLine(setCookies, session.SESSION_COOKIE_NAME)).toMatch(/Max-Age=0/);
  });

  it("does not call identity without a valid session", async () => {
    const { json } = await call("logout", { cookies: { [session.SESSION_COOKIE_NAME]: "tampered" } });
    expect(json).toEqual({ ok: true, next: "/sign-in?reason=signed_out" });
    expect(seen).toHaveLength(0);
  });

  it("rejects a cross-origin logout", async () => {
    const { res } = await call("logout", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("transport failures", () => {
  it("maps an unreachable identity to 502 with the client's code", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { createClient } = await import("./identity");
    const thrown = await createClient({ baseUrl: `http://127.0.0.1:${port}` })
      .emailStart({ email: "ada@example.com", intent: "signin" })
      .catch((err: unknown) => err);
    const res = lib.fromError(thrown);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, code: "network_error" });
  });
});
