// Server tests for social sign-in (#317): the provider buttons' start URLs and the
// `GET /auth/callback` handoff exchange against a mocked identity server (a real HTTP server on a
// random port that APILENS_API_URL points at), including open redirects through `next`.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "./identity";

const PUBLIC_URL = "http://ui.apilens.test";
const PUBLIC_API_URL = "https://api.apilens.test";
const ACCESS = "eyJhbGciOiJSUzI1NiJ9.ACCESS-TOKEN-SECRET.sig";
const REFRESH = "rt_REFRESH-TOKEN-SECRET";
const PRE_AUTH = "pat_PRE-AUTH-TOKEN-SECRET";
const CODE = "hoc_HANDOFF-CODE-abc_xyz-1";

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
let oauth: typeof import("./oauth");
let session: typeof import("./session");
let routes: typeof import("./auth-routes");

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.APILENS_API_URL = `http://127.0.0.1:${port}`;
  process.env.APILENS_PUBLIC_API_URL = `${PUBLIC_API_URL}/`;
  process.env.SESSION_SECRET = "z".repeat(48);
  process.env.APILENS_PUBLIC_URL = PUBLIC_URL;
  oauth = await import("./oauth");
  session = await import("./session");
  routes = await import("./auth-routes");
  GET = (await import("@/app/auth/callback/route")).GET;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  replies = {};
});

const problem = (status: number, code: string) => () => ({ status, body: { status, title: code, code } });

async function callback(query: Record<string, string>, cookies: Record<string, string> = {}) {
  const headers = new Headers({
    accept: "text/html",
    "user-agent": "Mozilla/5.0 (Test) Firefox/140",
    "x-forwarded-for": "203.0.113.7",
  });
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
  if (jar.length) headers.set("cookie", jar.join("; "));
  const res = await GET(new NextRequest(`${PUBLIC_URL}/auth/callback?${new URLSearchParams(query)}`, { headers }));
  const url = new URL(res.headers.get("location") ?? "", PUBLIC_URL);
  return { res, url, location: url.pathname + url.search, setCookies: res.headers.getSetCookie(), text: await res.text() };
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  return setCookies.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(";")[0];
}

describe("oauthStartUrl / oauthStartLinks", () => {
  it("points at identity's start endpoint with next, intent and remember", () => {
    const url = new URL(oauth.oauthStartUrl("https://api.example.com/", "github", { next: "/acme/requests?range=7d" }));
    expect(url.origin + url.pathname).toBe("https://api.example.com/api/v1/auth/oauth/github/start");
    expect(Object.fromEntries(url.searchParams)).toEqual({ next: "/acme/requests?range=7d", intent: "login", remember: "true" });
  });

  it.each(["//evil.example", "/\\evil.example", "https://evil.example/x", "javascript:alert(1)", "evil", `/${"a".repeat(600)}`])(
    "drops an off-origin next (%s)",
    (next) => {
      const url = new URL(oauth.oauthStartUrl("https://api.example.com", "google", { next }));
      expect(url.searchParams.has("next")).toBe(false);
      expect(url.host).toBe("api.example.com");
    },
  );

  it("builds links only for the enabled providers, on APILENS_PUBLIC_API_URL", () => {
    expect(oauth.oauthStartLinks({ google: false, github: false, sso: true }, "/x")).toEqual({});
    const links = oauth.oauthStartLinks({ google: true, github: false, sso: false }, "/x");
    expect(Object.keys(links)).toEqual(["google"]);
    expect(links.google).toBe(`${PUBLIC_API_URL}/api/v1/auth/oauth/google/start?next=%2Fx&intent=login&remember=true`);
  });
});

describe("GET /auth/callback", () => {
  it("success: redeems the code, seals the session and redirects to next", async () => {
    replies["POST /api/v1/auth/handoff"] = () => ({ status: 200, body: BUNDLE });
    const { res, location, setCookies, text } = await callback({ code: CODE });

    expect(res.status).toBe(302);
    expect(location).toBe("/acme/endpoints");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ code: CODE });
    expect(seen[0].headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(seen[0].headers["user-agent"]).toBe("Mozilla/5.0 (Test) Firefox/140");

    const opened = await session.open(cookieValue(setCookies, session.SESSION_COOKIE_NAME));
    expect(opened).toMatchObject({ access: ACCESS, refresh: REFRESH, remember: true, uid: "usr_1" });
    for (const secret of [ACCESS, REFRESH, CODE]) {
      expect(text).not.toContain(secret);
      expect(location).not.toContain(secret);
    }
  });

  it("a new user goes where identity points them (onboarding)", async () => {
    replies["POST /api/v1/auth/handoff"] = () => ({ status: 200, body: { ...BUNDLE, next: "/onboarding/about" } });
    expect((await callback({ code: CODE })).location).toBe("/onboarding/about");
  });

  it.each(["//evil.example", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", null])(
    "never redirects off-origin through next (%s)",
    async (next) => {
      replies["POST /api/v1/auth/handoff"] = () => ({ status: 200, body: { ...BUNDLE, next } });
      const { url, location } = await callback({ code: CODE, next: "//evil.example" });
      expect(url.origin).toBe(PUBLIC_URL);
      expect(location).toBe("/");
    },
  );

  it("2FA: parks the pre-auth token in its cookie and goes to the two-factor step", async () => {
    replies["POST /api/v1/auth/handoff"] = () => ({
      status: 200,
      body: { status: "2fa_required", pre_auth_token: PRE_AUTH, next: "/acme/endpoints" },
    });
    const { location, setCookies } = await callback({ code: CODE });
    expect(location).toBe("/auth/2fa?next=%2Facme%2Fendpoints");
    expect(cookieValue(setCookies, session.SESSION_COOKIE_NAME)).toBeUndefined();
    expect(cookieValue(setCookies, routes.PRE_AUTH_COOKIE_NAME)).toBeTruthy();
    expect(location).not.toContain(PRE_AUTH);
  });

  it("?error= goes back to the sign-in page with the code, without calling identity", async () => {
    expect((await callback({ error: "oauth_email_unverified" })).location).toBe("/sign-in?error=oauth_email_unverified");
    expect((await callback({ error: "<script>", code: CODE })).location).toBe("/sign-in?error=internal_error");
    expect(seen).toHaveLength(0);
  });

  it("a used or expired code lands on the sign-in page", async () => {
    replies["POST /api/v1/auth/handoff"] = problem(401, "invalid_token");
    const { location, setCookies } = await callback({ code: CODE });
    expect(location).toBe("/sign-in?error=invalid_token");
    expect(setCookies).toEqual([]);
  });

  it("a missing code never calls identity", async () => {
    expect((await callback({})).location).toBe("/sign-in?error=invalid_token");
    expect(seen).toHaveLength(0);
  });

  it("an identity failure lands on the sign-in page with its code", async () => {
    replies["POST /api/v1/auth/handoff"] = problem(503, "unavailable");
    expect((await callback({ code: CODE })).location).toBe("/sign-in?error=unavailable");
  });

  it("replacing a session revokes the previous one", async () => {
    replies["POST /api/v1/auth/handoff"] = () => ({ status: 200, body: BUNDLE });
    replies["POST /api/v1/auth/logout"] = () => ({ status: 204 });
    const old = await session.seal({ access: "old-access", refresh: "old-refresh", exp: 4_000_000_000, remember: true, uid: "usr_2" });
    const { location, setCookies } = await callback({ code: CODE }, { [session.SESSION_COOKIE_NAME]: old });
    expect(location).toBe("/acme/endpoints");
    expect(await session.open(cookieValue(setCookies, session.SESSION_COOKIE_NAME))).toMatchObject({ uid: "usr_1" });
    const logout = seen.find((s) => s.path === "/api/v1/auth/logout");
    expect(logout?.body).toEqual({ refresh_token: "old-refresh" });
    expect(logout?.headers.authorization).toBe("Bearer old-access");
  });
});
