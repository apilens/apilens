import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "../proxy";
import {
  LAST_PROJECT_COOKIE,
  ONBOARDING_PATH,
  REFRESH_HEADER,
  REFRESH_WINDOW_SECONDS,
  type GateRequest,
  decide,
  homeFor,
  isPublicPath,
} from "./auth-gate";
import { HOME_VIEW } from "./data";
import { SESSION_COOKIE_NAME, type SessionPayload, sealWithIv } from "./session-edge";

const NOW = 1_800_000_000;
const SESSION: SessionPayload = { access: "a", refresh: "r", exp: NOW + 900, remember: true, uid: "u1" };

function req(pathname: string, over: Partial<GateRequest> = {}): GateRequest {
  return { pathname, search: "", session: null, nowSeconds: NOW, dev: false, ...over };
}

describe("isPublicPath", () => {
  it.each(["/sign-in", "/sign-up", "/verify", "/auth", "/auth/callback", "/invite/abc", "/api/auth/login"])(
    "%s is public",
    (path) => expect(isPublicPath(path, false)).toBe(true),
  );

  it.each(["/", "/acme/incidents", "/onboarding/about", "/sign-in/x", "/verify/x", "/authx", "/invites", "/api/v1"])(
    "%s needs a session",
    (path) => expect(isPublicPath(path, false)).toBe(false),
  );

  it("/design* is public in development only", () => {
    expect(isPublicPath("/design", true)).toBe(true);
    expect(isPublicPath("/design/nav", true)).toBe(true);
    expect(isPublicPath("/design", false)).toBe(false);
    expect(isPublicPath("/design/nav", false)).toBe(false);
  });
});

describe("decide: signed out", () => {
  it("/ goes to /sign-in", () => {
    expect(decide(req("/"))).toEqual({ action: "redirect", location: "/sign-in" });
  });

  it("a protected page redirects with next = path + query", () => {
    expect(decide(req("/acme/incidents", { search: "?range=24h&x=a%20b" }))).toEqual({
      action: "redirect",
      location: `/sign-in?next=${encodeURIComponent("/acme/incidents?range=24h&x=a%20b")}`,
    });
  });

  it("drops next when it is not a safe same-origin path", () => {
    expect(decide(req(`/${"a".repeat(600)}`))).toEqual({ action: "redirect", location: "/sign-in" });
  });

  it("public pages pass without refresh", () => {
    for (const p of ["/sign-in", "/sign-up", "/verify", "/auth/callback", "/invite/t0k"]) {
      expect(decide(req(p))).toEqual({ action: "next", refresh: false });
    }
  });

  it("/design is gated in production but open in development", () => {
    expect(decide(req("/design")).action).toBe("redirect");
    expect(decide(req("/design", { dev: true }))).toEqual({ action: "next", refresh: false });
  });

  it("API routes other than /api/auth get 401", () => {
    expect(decide(req("/api/v1/projects"))).toEqual({ action: "unauthorized" });
    expect(decide(req("/api/auth/login"))).toEqual({ action: "next", refresh: false });
  });
});

describe("decide: signed in", () => {
  const signedIn = (pathname: string, over: Partial<GateRequest> = {}) => req(pathname, { session: SESSION, ...over });

  it("/ goes to the last project", () => {
    expect(decide(signedIn("/", { lastProject: "checkout-api" }))).toEqual({
      action: "redirect",
      location: `/checkout-api/${HOME_VIEW}`,
    });
  });

  it("/ goes to onboarding without a (valid) last project", () => {
    expect(decide(signedIn("/"))).toEqual({ action: "redirect", location: ONBOARDING_PATH });
    expect(decide(signedIn("/", { lastProject: "../evil" }))).toEqual({ action: "redirect", location: ONBOARDING_PATH });
  });

  it("/sign-in and /sign-up bounce to next or /", () => {
    expect(decide(signedIn("/sign-in"))).toEqual({ action: "redirect", location: "/" });
    expect(decide(signedIn("/sign-up", { search: "?next=%2Facme%2Fexplore%3Fq%3D1" }))).toEqual({
      action: "redirect",
      location: "/acme/explore?q=1",
    });
  });

  it.each(["//evil.com", "/\\evil.com", "javascript:alert(1)", "https://evil.com"])(
    "unsafe next %j falls back to /",
    (next) => {
      const search = `?${new URLSearchParams({ next })}`;
      expect(decide(signedIn("/sign-in", { search }))).toEqual({ action: "redirect", location: "/" });
    },
  );

  it("protected pages pass; refresh only within two minutes of expiry", () => {
    expect(decide(signedIn("/acme/incidents"))).toEqual({ action: "next", refresh: false });
    const near = { ...SESSION, exp: NOW + REFRESH_WINDOW_SECONDS };
    expect(decide(signedIn("/acme/incidents", { session: near }))).toEqual({ action: "next", refresh: true });
    const justOutside = { ...SESSION, exp: NOW + REFRESH_WINDOW_SECONDS + 1 };
    expect(decide(signedIn("/acme/incidents", { session: justOutside }))).toEqual({ action: "next", refresh: false });
    const expired = { ...SESSION, exp: NOW - 60 };
    expect(decide(signedIn("/acme/incidents", { session: expired }))).toEqual({ action: "next", refresh: true });
  });

  it("other public pages stay reachable", () => {
    expect(decide(signedIn("/verify"))).toEqual({ action: "next", refresh: false });
    expect(decide(signedIn("/invite/t0k"))).toEqual({ action: "next", refresh: false });
  });
});

describe("homeFor", () => {
  it.each([undefined, "", "-x", "x-", "A", "a/b", "a".repeat(65)])("%j falls back to onboarding", (slug) => {
    expect(homeFor(slug)).toBe(ONBOARDING_PATH);
  });
  it("accepts a project slug", () => expect(homeFor("acme")).toBe(`/acme/${HOME_VIEW}`));
});

describe("matcher", () => {
  const re = new RegExp(`^${config.matcher[0]}$`);

  it.each(["/", "/sign-in", "/acme/incidents", "/api/auth/login", "/design/nav", "/invite/abc"])(
    "runs on %s",
    (path) => expect(re.test(path)).toBe(true),
  );

  it.each(["/_next/static/chunks/app.js", "/_next/image", "/favicon.ico", "/brand/logo.svg", "/robots.txt"])(
    "skips %s",
    (path) => expect(re.test(path)).toBe(false),
  );
});

describe("proxy", () => {
  const SECRET = "x".repeat(32);
  process.env.SESSION_SECRET = SECRET;
  process.env.APILENS_API_URL = "http://api.test";
  process.env.APILENS_PUBLIC_URL = "http://ui.test";

  const cookieFor = (payload: SessionPayload) => sealWithIv(payload, SECRET, new Uint8Array(12).fill(7));

  function request(path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    return new NextRequest(`http://ui.test${path}`, { headers: { ...headers, ...(cookie ? { cookie } : {}) } });
  }

  const now = () => Math.floor(Date.now() / 1000);

  it("logged out at / redirects (302) to /sign-in", async () => {
    const res = await proxy(request("/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://ui.test/sign-in");
  });

  it("a present but tampered cookie counts as signed out and is cleared", async () => {
    const res = await proxy(request("/acme/incidents", { [SESSION_COOKIE_NAME]: "AQ" + "A".repeat(60) }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://ui.test/sign-in?next=%2Facme%2Fincidents");
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
  });

  it("logged in at / goes to the last project, else onboarding", async () => {
    const value = await cookieFor({ ...SESSION, exp: now() + 900 });
    let res = await proxy(request("/", { [SESSION_COOKIE_NAME]: value, [LAST_PROJECT_COOKIE]: "acme" }));
    expect(res.headers.get("location")).toBe(`http://ui.test/acme/${HOME_VIEW}`);
    res = await proxy(request("/", { [SESSION_COOKIE_NAME]: value }));
    expect(res.headers.get("location")).toBe(`http://ui.test${ONBOARDING_PATH}`);
  });

  it("sets the refresh header near expiry and strips a forged one otherwise", async () => {
    const near = await cookieFor({ ...SESSION, exp: now() + 30 });
    let res = await proxy(request("/acme/incidents", { [SESSION_COOKIE_NAME]: near }));
    expect(res.status).toBe(200);
    expect(res.headers.get(`x-middleware-request-${REFRESH_HEADER}`)).toBe("1");

    const fresh = await cookieFor({ ...SESSION, exp: now() + 900 });
    res = await proxy(request("/acme/incidents", { [SESSION_COOKIE_NAME]: fresh }, { [REFRESH_HEADER]: "1" }));
    expect(res.headers.get(`x-middleware-request-${REFRESH_HEADER}`)).toBeNull();
    expect(res.headers.get("x-middleware-override-headers")?.split(",")).not.toContain(REFRESH_HEADER);
  });

  it("API routes without a session get 401", async () => {
    const res = await proxy(request("/api/v1/projects"));
    expect(res.status).toBe(401);
  });
});
