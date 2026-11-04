import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VERIFY_RETRY_AFTER,
  countdown,
  twoFactorPath,
  verifyEmailCode,
  verifyErrorMessage,
  verifyRateLimitMessage,
  wrongCodeMessage,
} from "./email-verify";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const input = { email: "you@example.com", code: "123456", remember: true };

describe("verifyEmailCode", () => {
  it("posts {email, code, remember, next} to the Route Handler", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/orgs" }));
    await verifyEmailCode({ ...input, next: "/orgs" }, fetcher);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/auth/email/verify");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "you@example.com", code: "123456", remember: true, next: "/orgs" });
  });

  it("omits next when not given", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/" }));
    await verifyEmailCode({ ...input, remember: false }, fetcher);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ email: "you@example.com", code: "123456", remember: false });
  });

  it("signs in to the server's next, never off-origin", async () => {
    const ok = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/onboarding/about" }));
    expect(await verifyEmailCode(input, ok)).toEqual({ kind: "signed_in", next: "/onboarding/about" });
    const evil = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "//evil.example" }));
    expect(await verifyEmailCode({ ...input, next: "/orgs" }, evil)).toEqual({ kind: "signed_in", next: "/orgs" });
    const none = vi.fn<typeof fetch>(async () => json(200, { ok: true }));
    expect(await verifyEmailCode(input, none)).toEqual({ kind: "signed_in", next: "/" });
  });

  it("routes 2fa_required to the 2FA step carrying next", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: false, code: "2fa_required", next: "/orgs" }));
    expect(await verifyEmailCode(input, fetcher)).toEqual({ kind: "2fa_required", next: "/auth/2fa?next=%2Forgs" });
    const home = vi.fn<typeof fetch>(async () => json(200, { ok: false, code: "2fa_required", next: "/" }));
    expect(await verifyEmailCode(input, home)).toEqual({ kind: "2fa_required", next: "/auth/2fa" });
  });

  it("maps the identity codes", async () => {
    for (const code of ["invalid_code", "code_expired"] as const) {
      const fetcher = vi.fn<typeof fetch>(async () => json(400, { ok: false, code }));
      expect(await verifyEmailCode(input, fetcher)).toEqual({ kind: code });
    }
  });

  it("reads too_many_attempts by code even though it is a 429", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(429, { ok: false, code: "too_many_attempts" }));
    expect(await verifyEmailCode(input, fetcher)).toEqual({ kind: "too_many_attempts" });
  });

  it("maps rate_limited with retry_after from the body, the header, then a default", async () => {
    const body = vi.fn<typeof fetch>(async () => json(429, { ok: false, code: "rate_limited", retry_after: 17 }, { "Retry-After": "99" }));
    expect(await verifyEmailCode(input, body)).toEqual({ kind: "rate_limited", retryAfter: 17 });
    const header = vi.fn<typeof fetch>(async () => json(429, { ok: false, code: "rate_limited" }, { "Retry-After": "12" }));
    expect(await verifyEmailCode(input, header)).toEqual({ kind: "rate_limited", retryAfter: 12 });
    const bare = vi.fn<typeof fetch>(async () => new Response("slow down", { status: 429 }));
    expect(await verifyEmailCode(input, bare)).toEqual({ kind: "rate_limited", retryAfter: DEFAULT_VERIFY_RETRY_AFTER });
  });

  it("maps a thrown fetch and an unreachable identity to network", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await verifyEmailCode(input, offline)).toEqual({ kind: "network" });
    const gateway = vi.fn<typeof fetch>(async () => json(504, { ok: false, code: "timeout" }));
    expect(await verifyEmailCode(input, gateway)).toEqual({ kind: "network" });
    const proxy = vi.fn<typeof fetch>(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await verifyEmailCode(input, proxy)).toEqual({ kind: "network" });
  });

  it("passes any other code through", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(422, { ok: false, code: "validation_failed" }));
    expect(await verifyEmailCode(input, fetcher)).toEqual({ kind: "error", code: "validation_failed" });
  });
});

describe("copy", () => {
  it("counts attempts left", () => {
    expect(wrongCodeMessage(4)).toBe("Wrong code. 4 attempts left.");
    expect(wrongCodeMessage(1)).toBe("Wrong code. 1 attempt left.");
    expect(wrongCodeMessage(0)).toBe("Wrong code.");
  });

  it("counts the rate limit down", () => {
    expect(verifyRateLimitMessage(1)).toBe("Too many attempts. Try again in 1 second.");
    expect(verifyRateLimitMessage(9.2)).toBe("Too many attempts. Try again in 10 seconds.");
  });

  it("names validation failures and falls back for the rest", () => {
    expect(verifyErrorMessage("validation_failed")).toBe("Enter the 6-digit code from the email.");
    expect(verifyErrorMessage("internal")).toMatch(/Something went wrong/);
  });

  it("formats the resend countdown as m:ss", () => {
    expect(countdown(42)).toBe("0:42");
    expect(countdown(60)).toBe("1:00");
    expect(countdown(125)).toBe("2:05");
    expect(countdown(-3)).toBe("0:00");
  });

  it("builds the 2FA path", () => {
    expect(twoFactorPath(null)).toBe("/auth/2fa");
    expect(twoFactorPath("/orgs?x=1")).toBe("/auth/2fa?next=%2Forgs%3Fx%3D1");
  });
});
