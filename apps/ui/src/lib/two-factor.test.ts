import { describe, expect, it, vi } from "vitest";
import {
  cleanBackupCode,
  cleanTotp,
  exchangeTwoFactor,
  isBackupCode,
  startOverPath,
  twoFactorErrorMessage,
  wrongTwoFactorMessage,
} from "./two-factor";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("exchangeTwoFactor", () => {
  it("posts the proof alone to the Route Handler (the pre-auth token stays in its cookie)", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/orgs" }));
    await exchangeTwoFactor({ code: "123456" }, fetcher);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/auth/2fa/exchange");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ code: "123456" });

    await exchangeTwoFactor({ backup_code: "abcd-1234" }, fetcher);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ backup_code: "abcd-1234" });
  });

  it("signs in to the server's next, never off-origin", async () => {
    const ok = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/acme/requests" }));
    expect(await exchangeTwoFactor({ code: "123456" }, ok)).toEqual({ kind: "signed_in", next: "/acme/requests" });
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", undefined]) {
      const evil = vi.fn<typeof fetch>(async () => json(200, { ok: true, next }));
      expect(await exchangeTwoFactor({ code: "123456" }, evil)).toEqual({ kind: "signed_in", next: "/" });
    }
  });

  it("maps invalid_code and too_many_attempts by code", async () => {
    const wrong = vi.fn<typeof fetch>(async () => json(401, { ok: false, code: "invalid_code" }));
    expect(await exchangeTwoFactor({ code: "000000" }, wrong)).toEqual({ kind: "invalid_code" });
    const locked = vi.fn<typeof fetch>(async () => json(429, { ok: false, code: "too_many_attempts" }));
    expect(await exchangeTwoFactor({ code: "000000" }, locked)).toEqual({ kind: "too_many_attempts" });
  });

  it("treats a missing, expired or used pending sign-in as expired", async () => {
    for (const code of ["invalid_token", "2fa_session_expired"]) {
      const fetcher = vi.fn<typeof fetch>(async () => json(401, { ok: false, code }));
      expect(await exchangeTwoFactor({ code: "123456" }, fetcher)).toEqual({ kind: "expired" });
    }
  });

  it("reports network failures and unreachable identity as network", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await exchangeTwoFactor({ code: "123456" }, offline)).toEqual({ kind: "network" });
    for (const code of ["network_error", "timeout", "unavailable"]) {
      const fetcher = vi.fn<typeof fetch>(async () => json(502, { ok: false, code }));
      expect(await exchangeTwoFactor({ code: "123456" }, fetcher)).toEqual({ kind: "network" });
    }
    const proxy = vi.fn<typeof fetch>(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await exchangeTwoFactor({ code: "123456" }, proxy)).toEqual({ kind: "network" });
  });

  it("passes any other code through", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(422, { ok: false, code: "validation_failed" }));
    expect(await exchangeTwoFactor({ code: "12" }, fetcher)).toEqual({ kind: "error", code: "validation_failed" });
  });
});

describe("startOverPath", () => {
  it("goes to sign-in with the reason, carrying a same-origin next", () => {
    expect(startOverPath("2fa_locked")).toBe("/sign-in?reason=2fa_locked");
    expect(startOverPath("2fa_expired", "/")).toBe("/sign-in?reason=2fa_expired");
    expect(startOverPath("2fa_locked", "/acme/requests")).toBe("/sign-in?reason=2fa_locked&next=%2Facme%2Frequests");
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      expect(startOverPath("2fa_expired", next)).toBe("/sign-in?reason=2fa_expired");
    }
  });
});

describe("input cleaning", () => {
  it("keeps six digits of a TOTP code", () => {
    expect(cleanTotp("123 456")).toBe("123456");
    expect(cleanTotp("12-34-56-78")).toBe("123456");
    expect(cleanTotp("abc")).toBe("");
  });

  it("formats a backup code as xxxx-xxxx", () => {
    expect(cleanBackupCode("ABCD1234")).toBe("abcd-1234");
    expect(cleanBackupCode("abcd 1234")).toBe("abcd-1234");
    expect(cleanBackupCode("ab")).toBe("ab");
    expect(cleanBackupCode("abcd")).toBe("abcd");
    expect(cleanBackupCode("abcd-")).toBe("abcd");
    expect(cleanBackupCode("abcd-12345678")).toBe("abcd-1234");
    expect(isBackupCode("abcd-1234")).toBe(true);
    expect(isBackupCode("abcd-123")).toBe(false);
    expect(isBackupCode("abcd1234")).toBe(false);
  });
});

describe("copy", () => {
  it("counts attempts left", () => {
    expect(wrongTwoFactorMessage(false, 4)).toBe("Wrong code. 4 attempts left.");
    expect(wrongTwoFactorMessage(false, 1)).toBe("Wrong code. 1 attempt left.");
    expect(wrongTwoFactorMessage(true, 2)).toBe("That backup code didn’t work. 2 attempts left.");
    expect(wrongTwoFactorMessage(false, 0)).toBe("Wrong code.");
  });

  it("explains validation per mode and falls back to a generic line", () => {
    expect(twoFactorErrorMessage("validation_failed", false)).toMatch(/6-digit/);
    expect(twoFactorErrorMessage("invalid_request", true)).toMatch(/backup code/);
    expect(twoFactorErrorMessage("internal_error", false)).toBe("Something went wrong checking your code. Try again.");
  });
});
