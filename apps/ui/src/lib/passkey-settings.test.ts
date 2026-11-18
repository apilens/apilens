import { describe, expect, it } from "vitest";
import {
  checkPasskeyName,
  formatDay,
  formatExact,
  formatLastUsed,
  isPasskeyId,
  passkeySettingsError,
  passkeyVendor,
} from "./passkey-settings";

describe("checkPasskeyName", () => {
  it("trims and bounds the name", () => {
    expect(checkPasskeyName("  Work laptop ")).toEqual({ ok: true, name: "Work laptop" });
    expect(checkPasskeyName("  ")).toEqual({ ok: false, error: "Enter a name." });
    expect(checkPasskeyName("x".repeat(64))).toMatchObject({ ok: true });
    expect(checkPasskeyName("x".repeat(65))).toMatchObject({ ok: false });
    // Counted in characters, not UTF-16 units.
    expect(checkPasskeyName("🔑".repeat(64))).toMatchObject({ ok: true });
  });
});

describe("isPasskeyId", () => {
  it("accepts UUIDs only", () => {
    expect(isPasskeyId("7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isPasskeyId("../x")).toBe(false);
    expect(isPasskeyId(1)).toBe(false);
  });
});

describe("passkeyVendor", () => {
  it("prefers identity's AAGUID name", () => {
    expect(passkeyVendor({ authenticator: "iCloud Keychain", transports: ["internal"] })).toBe("iCloud Keychain");
  });

  it("falls back to the transports", () => {
    expect(passkeyVendor({ authenticator: "", transports: ["internal", "hybrid"] })).toBe("This device’s authenticator");
    expect(passkeyVendor({ authenticator: "", transports: ["hybrid"] })).toBe("Phone or tablet");
    expect(passkeyVendor({ authenticator: " ", transports: ["usb", "nfc"] })).toBe("Security key");
    expect(passkeyVendor({ authenticator: "", transports: null })).toBe("Unknown authenticator");
  });
});

describe("dates", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");

  it("formats the day in UTC", () => {
    expect(formatDay("2026-11-04T23:30:00Z", "UTC")).toBe("Nov 4, 2026");
    expect(formatDay("nope", "UTC")).toBe("");
  });

  it("formats in the user's zone", () => {
    // 23:30 UTC is 05:00 the next day in India.
    expect(formatDay("2026-11-04T23:30:00Z", "Asia/Kolkata")).toBe("Nov 5, 2026");
    expect(formatExact("2026-11-04T23:30:00Z", "UTC")).toMatch(/^Nov 4, 2026, 11:30\sPM UTC$/);
    expect(formatExact("2026-11-04T23:30:00Z", "Asia/Kolkata")).toMatch(/^Nov 5, 2026, 5:00\sAM IST$/);
    expect(formatExact("nope", "UTC")).toBe("");
    // 01:00 UTC on the 4th is 06:30 on the 4th in India; 18:40 UTC on the 3rd is already the 4th there.
    expect(formatLastUsed("2026-11-03T18:40:00Z", "Asia/Kolkata", now)).toBe("Today");
    expect(formatLastUsed("2026-11-03T18:40:00Z", "UTC", now)).toBe("Yesterday");
  });

  it.each([
    [null, "Never"],
    ["2026-11-04T01:00:00Z", "Today"],
    ["2026-11-03T23:59:00Z", "Yesterday"],
    ["2026-10-30T12:00:00Z", "5 days ago"],
    ["2026-09-01T12:00:00Z", "Sep 1, 2026"],
  ])("last used %j is %j", (iso, expected) => {
    expect(formatLastUsed(iso, "UTC", now)).toBe(expected);
  });
});

describe("passkeySettingsError", () => {
  it("stays silent when the user cancelled", () => {
    expect(passkeySettingsError("cancelled")).toBeNull();
  });

  it("explains the codes people can act on", () => {
    expect(passkeySettingsError("passkey_already_registered")).toMatch(/already holds a passkey/);
    expect(passkeySettingsError("unsupported")).toMatch(/can’t create passkeys/);
    expect(passkeySettingsError("whatever")).toBe("Something went wrong. Try again.");
  });
});
