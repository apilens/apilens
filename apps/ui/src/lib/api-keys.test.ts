import { describe, expect, it } from "vitest";
import {
  apiKeysError,
  checkExpiresAt,
  checkKeyName,
  checkScopes,
  expiryFor,
  isKeyId,
  isProjectSlug,
  keyStatus,
  keysPath,
  maskedKey,
  scopesLabel,
  todayUTC,
  withCreated,
} from "./api-keys";
import type { ApiKey } from "./identity";

const NOW = Date.parse("2026-11-04T12:00:00Z");

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b",
  name: "Production",
  prefix: "apl_live_abcdefg",
  scopes: ["ingest"],
  last_used_at: null,
  created_at: "2026-11-01T10:00:00Z",
  expires_at: null,
  revoked_at: null,
  ...over,
});

describe("keysPath", () => {
  it("is the keys section of the project's settings", () => {
    expect(keysPath("shop")).toBe("/shop/settings/keys");
  });
});

describe("checkKeyName", () => {
  it("trims and bounds the name", () => {
    expect(checkKeyName("  Production ")).toEqual({ ok: true, name: "Production" });
    expect(checkKeyName("   ")).toEqual({ ok: false, error: "Enter a name." });
    expect(checkKeyName("x".repeat(100))).toMatchObject({ ok: true });
    expect(checkKeyName("x".repeat(101))).toEqual({ ok: false, error: "Use at most 100 characters." });
  });
});

describe("checkScopes", () => {
  it("answers known scopes in API order without duplicates", () => {
    expect(checkScopes(["read", "ingest", "read"])).toEqual({ ok: true, scopes: ["ingest", "read"] });
    expect(checkScopes(["read"])).toEqual({ ok: true, scopes: ["read"] });
  });

  it("needs at least one known scope", () => {
    expect(checkScopes([])).toMatchObject({ ok: false });
    expect(checkScopes("ingest")).toMatchObject({ ok: false });
    expect(checkScopes(["ingest", "admin"])).toMatchObject({ ok: false });
  });
});

describe("expiryFor", () => {
  it("never expires by default", () => {
    expect(expiryFor("never", "", NOW)).toEqual({ ok: true, expiresAt: undefined });
  });

  it("counts preset days from now", () => {
    expect(expiryFor("30", "", NOW)).toEqual({ ok: true, expiresAt: "2026-12-04T12:00:00.000Z" });
    expect(expiryFor("365", "", NOW)).toEqual({ ok: true, expiresAt: "2027-11-04T12:00:00.000Z" });
  });

  it("keeps a custom date working through its end, UTC", () => {
    expect(expiryFor("custom", "2026-11-05", NOW)).toEqual({ ok: true, expiresAt: "2026-11-05T23:59:59.000Z" });
  });

  it("rejects a missing, invalid or past custom date", () => {
    expect(expiryFor("custom", "", NOW)).toEqual({ ok: false, error: "Pick a date." });
    expect(expiryFor("custom", "2026-02-30", NOW)).toEqual({ ok: false, error: "Pick a date." });
    expect(expiryFor("custom", "2026-11-04", NOW)).toEqual({ ok: false, error: "Pick a date after today." });
    expect(expiryFor("custom", "2025-01-01", NOW)).toEqual({ ok: false, error: "Pick a date after today." });
  });

  it("dates today in UTC", () => {
    expect(todayUTC(Date.parse("2026-11-04T23:30:00-05:00"))).toBe("2026-11-05");
  });
});

describe("checkExpiresAt", () => {
  it("accepts nothing or a future instant", () => {
    expect(checkExpiresAt(undefined, NOW)).toEqual({ ok: true, expiresAt: undefined });
    expect(checkExpiresAt("", NOW)).toEqual({ ok: true, expiresAt: undefined });
    expect(checkExpiresAt("2026-12-01T00:00:00+01:00", NOW)).toEqual({ ok: true, expiresAt: "2026-11-30T23:00:00.000Z" });
  });

  it("rejects garbage and the past", () => {
    expect(checkExpiresAt("soon", NOW)).toMatchObject({ ok: false });
    expect(checkExpiresAt(42, NOW)).toMatchObject({ ok: false });
    expect(checkExpiresAt("2026-11-01T00:00:00Z", NOW)).toMatchObject({ ok: false });
  });
});

describe("keyStatus", () => {
  it("is active, expired or revoked, revoked first", () => {
    expect(keyStatus(key(), NOW)).toBe("active");
    expect(keyStatus(key({ expires_at: "2026-12-01T00:00:00Z" }), NOW)).toBe("active");
    expect(keyStatus(key({ expires_at: "2026-11-01T00:00:00Z" }), NOW)).toBe("expired");
    expect(keyStatus(key({ expires_at: "2026-11-01T00:00:00Z", revoked_at: "2026-11-02T00:00:00Z" }), NOW)).toBe("revoked");
  });
});

describe("labels", () => {
  it("names scopes in API order", () => {
    expect(scopesLabel(["read", "ingest"])).toBe("Ingest, Read");
    expect(scopesLabel(null)).toBe("");
  });

  it("shows the prefix as the start of a key", () => {
    expect(maskedKey("apl_live_abcdefg")).toBe("apl_live_abcdefg…");
  });
});

describe("withCreated", () => {
  it("puts the new key first, once", () => {
    const a = key({ id: "a" });
    const b = key({ id: "b" });
    expect(withCreated([a], b).map((k) => k.id)).toEqual(["b", "a"]);
    expect(withCreated([b, a], b).map((k) => k.id)).toEqual(["b", "a"]);
  });
});

describe("ids", () => {
  it("accepts UUIDs and project slugs only", () => {
    expect(isKeyId("7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isKeyId("../x")).toBe(false);
    expect(isProjectSlug("shop")).toBe(true);
    expect(isProjectSlug("../shop")).toBe(false);
    expect(isProjectSlug("Shop")).toBe(false);
  });
});

describe("apiKeysError", () => {
  it("has a sentence for every code", () => {
    expect(apiKeysError("forbidden")).toBe("You don’t have permission to manage this project’s API keys.");
    expect(apiKeysError("api_key_gone")).toMatch(/no longer exists/);
    expect(apiKeysError("anything")).toBe("Something went wrong. Try again in a moment.");
  });
});
