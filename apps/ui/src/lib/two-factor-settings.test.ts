import { describe, expect, it } from "vitest";
import { backupCodesLeft, backupCodesText, enabledSince, groupSecret, isTotp, twoFactorSettingsError } from "./two-factor-settings";

describe("isTotp", () => {
  it("accepts exactly six digits", () => {
    expect(isTotp("012345")).toBe(true);
    for (const bad of ["", "12345", "1234567", "12a456", " 123456"]) expect(isTotp(bad)).toBe(false);
  });
});

describe("groupSecret", () => {
  it("groups the base32 secret in fours", () => {
    expect(groupSecret("jbswy3dpehpk3pxpjbswy3dpehpk3pxp")).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    expect(groupSecret("ABCDEF==")).toBe("ABCD EF");
    expect(groupSecret("")).toBe("");
  });
});

describe("backupCodesLeft", () => {
  it("counts in words", () => {
    expect(backupCodesLeft(10)).toBe("10 backup codes left");
    expect(backupCodesLeft(1)).toBe("1 backup code left");
    expect(backupCodesLeft(0)).toBe("No backup codes left");
  });
});

describe("enabledSince", () => {
  it("formats a date and ignores missing or bad ones", () => {
    expect(enabledSince("2026-11-04T10:00:00Z", "en-GB")).toBe("since 4 Nov 2026");
    expect(enabledSince(null)).toBe("");
    expect(enabledSince("nope")).toBe("");
  });
});

describe("backupCodesText", () => {
  it("lists every code under a header naming the account and the date", () => {
    const text = backupCodesText(["abcd-2345", "efgh-6777"], "you@example.com", new Date("2026-11-04T12:00:00Z"));
    const lines = text.split("\n");
    expect(lines[0]).toBe("APILens backup codes");
    expect(lines).toContain("Account: you@example.com");
    expect(lines).toContain("Generated: 2026-11-04");
    expect(lines.slice(-3)).toEqual(["abcd-2345", "efgh-6777", ""]);
  });

  it("leaves the account out when unknown", () => {
    expect(backupCodesText(["abcd-2345"], null)).not.toContain("Account:");
  });
});

describe("twoFactorSettingsError", () => {
  it("has a sentence for each code identity answers", () => {
    expect(twoFactorSettingsError("invalid_totp")).toMatch(/^Wrong code\./);
    expect(twoFactorSettingsError("invalid_totp", true)).toMatch(/^That backup code didn’t work\./);
    expect(twoFactorSettingsError("reauth_required")).toMatch(/sign in again/);
    expect(twoFactorSettingsError("not_enabled")).toMatch(/already off/);
    expect(twoFactorSettingsError("already_enabled")).toMatch(/already on/);
    expect(twoFactorSettingsError("network_error")).toMatch(/couldn’t reach/);
    expect(twoFactorSettingsError("whatever")).toBe("Something went wrong. Try again.");
  });

  it("never shouts", () => {
    for (const code of ["invalid_totp", "invalid_request", "reauth_required", "rate_limited", "x"]) {
      expect(twoFactorSettingsError(code)).not.toContain("!");
    }
  });
});
