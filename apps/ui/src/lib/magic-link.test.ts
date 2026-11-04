// Server tests for the magic-link landing (#316): the `/verify` decision (`verifyLanding`) and the
// `GET /api/auth/email/verify-link` exchange against a mocked identity server (a real HTTP server
// on a random port that APILENS_API_URL points at), covering success, expired and used links.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "./identity";
import type { SessionPayload } from "./session-format";

const PUBLIC_URL = "http://ui.apilens.test";
const ACCESS = "eyJhbGciOiJSUzI1NiJ9.ACCESS-TOKEN-SECRET.sig";
const REFRESH = "rt_REFRESH-TOKEN-SECRET";
const PRE_AUTH = "pat_PRE-AUTH-TOKEN-SECRET";
const LINK = "mlt_LINK-TOKEN-abc/xyz+1";

const USER: User = {
  id: "usr_1",
  email: "ada@example.com",
  email_verified: true,
  name: "Ada",
  avatar_url: null,
  preferences: {},
  onboarding: { step: null, completed: true },
  created_at: "2026-11-01T00:00:00Z",
};
const BUNDLE = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 900, user: USER, next: "/acme/endpoints" };

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
    const reply = replies[`${entry.method} ${entry.path}`]?.(entry) ?? {
      status: 404,
      body: { status: 404, title: "Not Found", code: "not_found" },
    };
    res.writeHead(reply.status, { "content-type": reply.status >= 400 ? "application/problem+json" : "application/json" });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
}

let GET: (req: NextRequest) => Promise<Response>;
let ml: typeof import("./magic-link");
let session: typeof import("./session");
let routes: typeof import("./auth-routes");

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.APILENS_API_URL = `http://127.0.0.1:${port}`;
  process.env.SESSION_SECRET = "y".repeat(48);
  process.env.APILENS_PUBLIC_URL = PUBLIC_URL;
  ml = await import("./magic-link");
  session = await import("./session");
  routes = await import("./auth-routes");
  GET = (await import("@/app/api/auth/email/verify-link/route")).GET;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  replies = {};
});

const problem = (status: number, code: string) => () => ({ status, body: { status, title: code, code } });

async function open(query: Record<string, string>, cookies: Record<string, string> = {}) {
  const headers = new Headers({
    accept: "text/html",
    "user-agent": "Mozilla/5.0 (Test) Firefox/140",
    "x-forwarded-for": "203.0.113.7",
  });
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
  if (jar.length) headers.set("cookie", jar.join("; "));
  const res = await GET(new NextRequest(`${PUBLIC_URL}/api/auth/email/verify-link?${new URLSearchParams(query)}`, { headers }));
  const location = res.headers.get("location") ?? "";
  const url = new URL(location, PUBLIC_URL);
  return { res, location: url.pathname + url.search, url, setCookies: res.headers.getSetCookie(), text: await res.text() };
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  return setCookies.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(";")[0];
}

describe("GET /api/auth/email/verify-link", () => {
  it("success: exchanges the token, seals the session and redirects to next", async () => {
    replies["POST /api/v1/auth/email/verify-link"] = () => ({ status: 200, body: BUNDLE });
    const { res, location, setCookies, text } = await open({ token: LINK, email: "ada@example.com", next: "/acme/requests" });

    expect(res.status).toBe(302);
    expect(location).toBe("/acme/requests");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ token: LINK, remember: true });
    expect(seen[0].headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(seen[0].headers["user-agent"]).toBe("Mozilla/5.0 (Test) Firefox/140");

    const sealed = cookieValue(setCookies, session.SESSION_COOKIE_NAME);
    expect(sealed).toBeTruthy();
    const opened = await session.open(sealed);
    expect(opened).toMatchObject({ access: ACCESS, refresh: REFRESH, remember: true, uid: "usr_1" });
    for (const secret of [ACCESS, REFRESH, LINK]) {
      expect(text).not.toContain(secret);
      expect(location).not.toContain(secret);
    }
  });

  it("success: falls back to the next stored with the email, and refuses an off-origin next", async () => {
    replies["POST /api/v1/auth/email/verify-link"] = () => ({ status: 200, body: BUNDLE });
    const { location } = await open({ token: LINK, next: "//evil.example" });
    expect(location).toBe("/acme/endpoints");
  });

  it("success with 2FA: parks the pre-auth token in its cookie and goes to the 2FA step", async () => {
    replies["POST /api/v1/auth/email/verify-link"] = () => ({
      status: 200,
      body: { status: "2fa_required", pre_auth_token: PRE_AUTH, next: "/acme/endpoints" },
    });
    const { location, setCookies } = await open({ token: LINK });
    expect(location).toBe("/auth/2fa?next=%2Facme%2Fendpoints");
    expect(cookieValue(setCookies, session.SESSION_COOKIE_NAME)).toBeUndefined();
    expect(cookieValue(setCookies, routes.PRE_AUTH_COOKIE_NAME)).toBeTruthy();
    expect(location).not.toContain(PRE_AUTH);
  });

  it("expired: code_expired lands on the expired state with the email kept and the token dropped", async () => {
    replies["POST /api/v1/auth/email/verify-link"] = problem(400, "code_expired");
    const { res, location, url, setCookies } = await open({ token: LINK, email: "ada@example.com", next: "/acme/requests" });
    expect(res.status).toBe(302);
    expect(url.pathname).toBe("/verify");
    expect(Object.fromEntries(url.searchParams)).toEqual({ link: "expired", email: "ada@example.com", next: "/acme/requests" });
    expect(location).not.toContain("token");
    expect(setCookies).toEqual([]);
  });

  it("used: invalid_token (already used or superseded) lands on the same expired state", async () => {
    replies["POST /api/v1/auth/email/verify-link"] = problem(401, "invalid_token");
    const { location, setCookies } = await open({ token: LINK, email: "ada@example.com" });
    expect(location).toBe("/verify?link=expired&email=ada%40example.com");
    expect(setCookies).toEqual([]);
  });

  it("used: a second open of a link that worked once is refused", async () => {
    let uses = 0;
    replies["POST /api/v1/auth/email/verify-link"] = () => (uses++ === 0 ? { status: 200, body: BUNDLE } : problem(401, "invalid_token")());
    expect((await open({ token: LINK })).location).toBe("/acme/endpoints");
    const again = await open({ token: LINK, email: "ada@example.com" });
    expect(again.location).toBe("/verify?link=expired&email=ada%40example.com");
    expect(cookieValue(again.setCookies, session.SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("an unreachable identity lands on the error state, not the expired one", async () => {
    replies["POST /api/v1/auth/email/verify-link"] = problem(503, "unavailable");
    expect((await open({ token: LINK, email: "ada@example.com" })).location).toBe("/verify?link=error&email=ada%40example.com");
  });

  it("a missing token never calls identity", async () => {
    const { location } = await open({ email: "ada@example.com" });
    expect(location).toBe("/verify?link=expired&email=ada%40example.com");
    expect(seen).toHaveLength(0);
  });

  it("switching accounts revokes the previous session", async () => {
    replies["POST /api/v1/auth/email/verify-link"] = () => ({ status: 200, body: BUNDLE });
    replies["POST /api/v1/auth/logout"] = () => ({ status: 204 });
    const old = await session.seal({ access: "old-access", refresh: "old-refresh", exp: 4_000_000_000, remember: true, uid: "usr_2" });
    const { location, setCookies } = await open({ token: LINK }, { [session.SESSION_COOKIE_NAME]: old });
    expect(location).toBe("/acme/endpoints");
    expect(await session.open(cookieValue(setCookies, session.SESSION_COOKIE_NAME))).toMatchObject({ uid: "usr_1" });
    const logout = seen.find((s) => s.path === "/api/v1/auth/logout");
    expect(logout?.body).toEqual({ refresh_token: "old-refresh" });
    expect(logout?.headers.authorization).toBe("Bearer old-access");
  });
});

describe("verifyLanding (/verify)", () => {
  const SIGNED_IN: SessionPayload = { access: "a", refresh: "r", exp: 4_000_000_000, remember: true, uid: "usr_1" };
  const noMe = () => Promise.reject(new Error("me must not be called"));

  it("without a token renders the code page", async () => {
    expect(await ml.verifyLanding({ email: "ada@example.com" }, { session: null, me: noMe })).toEqual({ kind: "code" });
  });

  it("signed out: hands the token to the exchange route, keeping email and a safe next", async () => {
    const landing = await ml.verifyLanding(
      { token: LINK, email: "ada@example.com", next: "/acme/requests" },
      { session: null, me: noMe },
    );
    expect(landing).toEqual({
      kind: "exchange",
      location: `/api/auth/email/verify-link?${new URLSearchParams({ token: LINK, email: "ada@example.com", next: "/acme/requests" })}`,
    });
    const offsite = await ml.verifyLanding({ token: LINK, next: "https://evil.example" }, { session: null, me: noMe });
    expect(offsite).toEqual({ kind: "exchange", location: `/api/auth/email/verify-link?${new URLSearchParams({ token: LINK })}` });
  });

  it("signed in as the link's address: continues without spending the link", async () => {
    const landing = await ml.verifyLanding(
      { token: LINK, email: "ADA@example.com", next: "/acme/requests" },
      { session: SIGNED_IN, me: async () => USER },
    );
    expect(landing).toEqual({ kind: "continue", location: "/acme/requests" });
  });

  it("signed in as someone else: offers continue or switch", async () => {
    const landing = await ml.verifyLanding({ token: LINK, email: "grace@example.com" }, { session: SIGNED_IN, me: async () => USER });
    expect(landing).toEqual({
      kind: "signed_in_as",
      current: "ada@example.com",
      linkEmail: "grace@example.com",
      continueTo: "/",
      switchTo: `/api/auth/email/verify-link?${new URLSearchParams({ token: LINK, email: "grace@example.com" })}`,
    });
  });

  it("signed in but the link names no address: still asks before switching", async () => {
    const landing = await ml.verifyLanding({ token: LINK }, { session: SIGNED_IN, me: async () => USER });
    expect(landing).toMatchObject({ kind: "signed_in_as", current: "ada@example.com", linkEmail: undefined });
  });

  it("an unusable session falls through to the exchange", async () => {
    const landing = await ml.verifyLanding(
      { token: LINK },
      { session: SIGNED_IN, me: () => Promise.reject(new Error("expired")) },
    );
    expect(landing.kind).toBe("exchange");
  });

  it.each([
    [{ link: "expired", email: "ada@example.com" }, { kind: "problem", problem: "expired", email: "ada@example.com", next: undefined }],
    [{ link: "error", next: "/acme" }, { kind: "problem", problem: "error", email: undefined, next: "/acme" }],
    [{ link: "expired", email: "<script>" }, { kind: "problem", problem: "expired", email: undefined, next: undefined }],
    [{ link: "bogus" }, { kind: "code" }],
    [{ token: "x".repeat(3000) }, { kind: "problem", problem: "expired", email: undefined, next: undefined }],
  ])("renders the link state for %j", async (query, want) => {
    expect(await ml.verifyLanding(query, { session: null, me: noMe })).toEqual(want);
  });
});
