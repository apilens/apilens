import { describe, expect, it } from "vitest";
import { countdown, postRecovery, recoveryErrorMessage, waitMessage } from "./recovery-client";

function fake(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("postRecovery", () => {
  it("posts JSON to the action's Route Handler", async () => {
    const { fetcher, calls } = fake(200, { ok: true, next: "/auth/recovery" });
    expect(await postRecovery("request", { email: "ada@example.com" }, fetcher)).toEqual({ kind: "ok", next: "/auth/recovery" });
    expect(calls[0].url).toBe("/api/auth/recovery/request");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: "ada@example.com" });
  });

  it("never follows an off-origin next", async () => {
    const { fetcher } = fake(200, { ok: true, next: "//evil.example.com" });
    expect(await postRecovery("confirm", { token: "t" }, fetcher)).toEqual({ kind: "ok", next: "/" });
  });

  it("maps every refusal", async () => {
    expect(await postRecovery("confirm", { token: "t" }, fake(409, { ok: false, code: "recovery_not_ready", retry_after: 90 }).fetcher)).toEqual({
      kind: "not_ready",
      retryAfter: 90,
    });
    expect(await postRecovery("confirm", { token: "t" }, fake(401, { ok: false, code: "invalid_token" }).fetcher)).toEqual({ kind: "invalid_token" });
    expect(await postRecovery("request", { email: "a@example.com" }, fake(429, { ok: false, code: "rate_limited" }, { "retry-after": "12" }).fetcher)).toEqual({
      kind: "rate_limited",
      retryAfter: 12,
    });
    expect(await postRecovery("cancel", { token: "t" }, fake(503, { ok: false, code: "unavailable" }).fetcher)).toEqual({ kind: "network" });
    expect(await postRecovery("cancel", { token: "t" }, fake(502, "<html>bad gateway</html>").fetcher)).toEqual({ kind: "network" });
    expect(await postRecovery("request", { email: "x" }, fake(422, { ok: false, code: "validation_failed" }).fetcher)).toEqual({
      kind: "error",
      code: "validation_failed",
    });
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await postRecovery("cancel", { token: "t" }, offline)).toEqual({ kind: "network" });
  });
});

describe("copy", () => {
  it("countdown", () => {
    expect(countdown(23 * 3600 + 59 * 60 + 30)).toBe("23 h 59 m");
    expect(countdown(3600)).toBe("1 h 00 m");
    expect(countdown(245)).toBe("4 m 05 s");
    expect(countdown(12)).toBe("12 s");
    expect(countdown(-3)).toBe("0 s");
  });

  it("waitMessage", () => {
    expect(waitMessage(1)).toBe("Too many attempts. Try again in 1 second.");
    expect(waitMessage(30)).toBe("Too many attempts. Try again in 30 seconds.");
    expect(waitMessage(300)).toBe("Too many attempts. Try again in 5 minutes.");
  });

  it("recoveryErrorMessage", () => {
    expect(recoveryErrorMessage("validation_failed")).toBe("Enter a work email like you@company.com.");
    expect(recoveryErrorMessage("internal_error")).toBe("Something went wrong. Try again in a moment.");
  });
});
