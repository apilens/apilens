import { describe, expect, it, vi } from "vitest";
import { emailStartError, startEmailSignIn } from "./email-sign-in";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

describe("startEmailSignIn", () => {
  it("posts {email, intent: signin, next} and returns the verify page", async () => {
    const f = reply(200, { ok: true, next: "/verify?flow=signin&email=ada%40example.com", retry_after: 30 });
    const res = await startEmailSignIn({ email: " ada@example.com ", next: "/acme/requests" }, f);
    expect(res).toEqual({ ok: true, next: "/verify?flow=signin&email=ada%40example.com", retryAfter: 30 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/email/start");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "ada@example.com", intent: "signin", next: "/acme/requests" });
  });

  it("omits next when there is none", async () => {
    const f = reply(200, { ok: true, next: "/verify" });
    await startEmailSignIn({ email: "ada@example.com" }, f);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ email: "ada@example.com", intent: "signin" });
  });

  it("carries the start URL of a sso_required refusal", async () => {
    const start = "https://id.apilens.test/api/v1/auth/sso/acme/start?remember=true";
    const f = reply(403, { ok: false, code: "sso_required", start_url: start });
    expect(await startEmailSignIn({ email: "ada@example.com" }, f)).toEqual({
      ok: false,
      code: "sso_required",
      retryAfter: null,
      startUrl: start,
    });
    expect(emailStartError("sso_required", null)).toMatch(/single sign-on/);
  });

  it("passes the route's code and retry_after through", async () => {
    const res = await startEmailSignIn({ email: "a@b.co" }, reply(429, { ok: false, code: "rate_limited", retry_after: 42 }));
    expect(res).toEqual({ ok: false, code: "rate_limited", retryAfter: 42 });
  });

  it("maps a non-JSON 502 and a transport failure", async () => {
    expect(await startEmailSignIn({ email: "a@b.co" }, reply(502, "<html>bad gateway</html>"))).toEqual({
      ok: false,
      code: "server_error",
      retryAfter: null,
    });
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await startEmailSignIn({ email: "a@b.co" }, down)).toEqual({ ok: false, code: "network_error", retryAfter: null });
  });

  it("refuses an off-origin next from the response", async () => {
    const res = await startEmailSignIn({ email: "a@b.co" }, reply(200, { ok: true, next: "//evil.example" }));
    expect(res.ok).toBe(false);
  });
});

describe("emailStartError", () => {
  it("has copy for the common failures", () => {
    expect(emailStartError("rate_limited", 42)).toContain("42 seconds");
    expect(emailStartError("rate_limited", null)).toContain("in a moment");
    expect(emailStartError("validation_failed", null)).toContain("you@company.com");
    expect(emailStartError("network_error", null)).toContain("connection");
    expect(emailStartError("server_error", null)).toContain("Couldn’t send");
  });
});
