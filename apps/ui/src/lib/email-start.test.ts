import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETRY_AFTER,
  NETWORK_MESSAGE,
  errorMessage,
  rateLimitMessage,
  startEmail,
  withRetryAfter,
} from "./email-start";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("startEmail", () => {
  it("posts {email, intent, next} to the Route Handler", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/verify?flow=signup&email=a%40b.io", retry_after: 30 }));
    await startEmail({ email: "a@b.io", intent: "signup", next: "/orgs" }, fetcher);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/auth/email/start");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "a@b.io", intent: "signup", next: "/orgs" });
  });

  it("omits next when not given", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/verify?flow=signup&email=a%40b.io" }));
    await startEmail({ email: "a@b.io", intent: "signup" }, fetcher);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ email: "a@b.io", intent: "signup" });
  });

  it("routes to /verify carrying the server's retry_after", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/verify?flow=signup&email=a%40b.io", retry_after: 30 }));
    const res = await startEmail({ email: "a@b.io", intent: "signup" }, fetcher);
    expect(res).toEqual({ kind: "sent", next: "/verify?flow=signup&email=a%40b.io&retry_after=30", retryAfter: 30 });
  });

  it("builds the /verify path itself when next is missing or not /verify", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "https://evil.example" }));
    const res = await startEmail({ email: "a@b.io", intent: "signup", next: "/orgs" }, fetcher);
    expect(res).toEqual({ kind: "sent", next: "/verify?flow=signup&email=a%40b.io&next=%2Forgs", retryAfter: null });
  });

  it("maps 429 to rate_limited using retry_after from the body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(429, { ok: false, code: "rate_limited", retry_after: 17 }, { "Retry-After": "99" }));
    expect(await startEmail({ email: "a@b.io", intent: "signup" }, fetcher)).toEqual({ kind: "rate_limited", retryAfter: 17 });
  });

  it("falls back to the Retry-After header, then a default", async () => {
    const header = vi.fn<typeof fetch>(async () => json(429, { ok: false, code: "rate_limited" }, { "Retry-After": "12" }));
    expect(await startEmail({ email: "a@b.io", intent: "signup" }, header)).toEqual({ kind: "rate_limited", retryAfter: 12 });
    const none = vi.fn<typeof fetch>(async () => new Response("slow down", { status: 429 }));
    expect(await startEmail({ email: "a@b.io", intent: "signup" }, none)).toEqual({ kind: "rate_limited", retryAfter: DEFAULT_RETRY_AFTER });
  });

  it("maps a thrown fetch and an unreachable identity to network", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await startEmail({ email: "a@b.io", intent: "signup" }, offline)).toEqual({ kind: "network" });
    const gateway = vi.fn<typeof fetch>(async () => json(502, { ok: false, code: "network_error" }));
    expect(await startEmail({ email: "a@b.io", intent: "signup" }, gateway)).toEqual({ kind: "network" });
    const proxy = vi.fn<typeof fetch>(async () => new Response("<html>bad gateway</html>", { status: 503 }));
    expect(await startEmail({ email: "a@b.io", intent: "signup" }, proxy)).toEqual({ kind: "network" });
  });

  it("passes any other code through", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(422, { ok: false, code: "validation_failed" }));
    expect(await startEmail({ email: "a@b.io", intent: "signup" }, fetcher)).toEqual({ kind: "error", code: "validation_failed" });
  });
});

describe("withRetryAfter", () => {
  it("adds or replaces retry_after and keeps the other params", () => {
    expect(withRetryAfter("/verify?flow=signup&email=a%40b.io", 30)).toBe("/verify?flow=signup&email=a%40b.io&retry_after=30");
    expect(withRetryAfter("/verify?retry_after=1", 5)).toBe("/verify?retry_after=5");
    expect(withRetryAfter("/verify", 5)).toBe("/verify?retry_after=5");
    expect(withRetryAfter("/verify?x=1", null)).toBe("/verify?x=1");
  });
});

describe("copy", () => {
  const all = [rateLimitMessage(1), rateLimitMessage(42), NETWORK_MESSAGE, errorMessage("validation_failed"), errorMessage("whatever")];

  it("says how long to wait", () => {
    expect(rateLimitMessage(42)).toBe("Too many attempts. Try again in 42 seconds.");
    expect(rateLimitMessage(1)).toBe("Too many attempts. Try again in 1 second.");
    expect(rateLimitMessage(0)).toBe("Too many attempts. Try again in 1 second.");
  });

  it("is sentence case with no exclamation marks", () => {
    for (const text of all) {
      expect(text).not.toContain("!");
      expect(text[0]).toBe(text[0].toUpperCase());
      expect(text.endsWith(".")).toBe(true);
    }
  });
});
