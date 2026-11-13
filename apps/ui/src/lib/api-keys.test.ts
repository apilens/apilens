import { describe, expect, it } from "vitest";
import {
  APP_NAME_PLACEHOLDER,
  KEYS_PAGE,
  accessBody,
  accessError,
  accessOf,
  appScopeText,
  appsSeen,
  checkAppIds,
  nameList,
  permissionSummary,
  revealAppHint,
  revealSnippet,
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
import { pageRedirect, parsePage, slicePage } from "./pagination";

const NOW = Date.parse("2026-11-04T12:00:00Z");

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b",
  name: "Production",
  prefix: "apl_live_abcdefg",
  scopes: ["ingest"],
  can_create_apps: true,
  app_ids: null,
  apps_seen: [],
  last_used_at: null,
  created_at: "2026-11-01T10:00:00Z",
  expires_at: null,
  revoked_at: null,
  ...over,
});

describe("keysPath", () => {
  it("is the keys section of the project's settings", () => {
    expect(keysPath("shop")).toBe("/shop/access/keys");
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

  it("says an unknown app was picked when an access change is refused as invalid", () => {
    expect(accessError("invalid_request")).toBe("One of the apps no longer exists. Reload the page and choose again.");
    expect(accessError("api_key_gone")).toMatch(/no longer exists/);
  });
});

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const A3 = "33333333-3333-4333-8333-333333333333";

describe("permissionSummary", () => {
  it("says what an ingest key does with apps", () => {
    expect(permissionSummary(key())).toBe("Ingest · Can create apps");
    expect(permissionSummary(key({ can_create_apps: false }))).toBe("Ingest · Existing apps only");
    expect(permissionSummary(key({ app_ids: [A1, A2], can_create_apps: false }))).toBe("Ingest · Limited to 2 apps");
    expect(permissionSummary(key({ app_ids: [A1], can_create_apps: true }))).toBe("Ingest · Limited to 1 app");
    expect(permissionSummary(key({ scopes: ["ingest", "read", "apps:create"] }))).toBe("Ingest, Read · Can create apps");
  });

  it("leaves app access out for keys that send nothing", () => {
    expect(permissionSummary(key({ scopes: ["read"] }))).toBe("Read");
    expect(permissionSummary(key({ scopes: null }))).toBe("No access");
  });
});

describe("accessOf and accessBody", () => {
  it("treats a key limited to apps as never creating apps", () => {
    expect(accessOf(key({ app_ids: [A1], can_create_apps: true }))).toEqual({ canCreateApps: false, appIds: [A1] });
    expect(accessOf(key({ can_create_apps: false }))).toEqual({ canCreateApps: false, appIds: null });
    expect(accessBody({ canCreateApps: true, appIds: [A2] })).toEqual({ can_create_apps: false, app_ids: [A2] });
    expect(accessBody({ canCreateApps: true, appIds: null })).toEqual({ can_create_apps: true, app_ids: null });
  });
});

describe("appScopeText", () => {
  const names = new Map([
    [A1, "Checkout API"],
    [A2, "Orders"],
    [A3, "Billing"],
  ]);

  it("names the allowed apps, or says all apps", () => {
    expect(appScopeText(key(), names)).toBe("All apps");
    expect(appScopeText(key({ app_ids: [A1] }), names)).toBe("Checkout API");
    expect(appScopeText(key({ app_ids: [A1, A2] }), names)).toBe("Checkout API and Orders");
    expect(appScopeText(key({ app_ids: [A2, "44444444-4444-4444-8444-444444444444"] }), names)).toBe("Orders and a removed app");
    expect(appScopeText(key({ scopes: ["read"] }), names)).toBe("");
  });

  it("shortens long lists", () => {
    expect(nameList(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
    expect(nameList(["a", "b", "c"])).toBe("a, b and c");
    expect(nameList([])).toBe("");
  });
});

describe("appsSeen", () => {
  it("lists the most recent first and tolerates null", () => {
    const seen = [
      { app_id: A1, slug: "checkout", name: "Checkout", first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-02T00:00:00Z" },
      { app_id: A2, slug: "orders", name: "Orders", first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-04T00:00:00Z" },
    ];
    expect(appsSeen(key({ apps_seen: seen })).map((a) => a.slug)).toEqual(["orders", "checkout"]);
    expect(appsSeen(key({ apps_seen: null }))).toEqual([]);
  });
});

describe("checkAppIds", () => {
  it("passes null through as every app and deduplicates ids", () => {
    expect(checkAppIds(undefined)).toEqual({ ok: true, appIds: null });
    expect(checkAppIds(null)).toEqual({ ok: true, appIds: null });
    expect(checkAppIds([A1, A2, A1])).toEqual({ ok: true, appIds: [A1, A2] });
  });

  it("refuses an empty pick and junk", () => {
    expect(checkAppIds([])).toEqual({ ok: false, error: "Choose at least one app, or allow every app." });
    expect(checkAppIds(["checkout"]).ok).toBe(false);
    expect(checkAppIds("x").ok).toBe(false);
  });
});

describe("revealSnippet", () => {
  const slugs = new Map([[A2, "orders"]]);

  it("shows the key and a placeholder app name to replace", () => {
    expect(revealSnippet("apl_live_x", { canCreateApps: true, appIds: null }, slugs)).toBe(`export APILENS_API_KEY=apl_live_x\nexport APILENS_APP_ID=${APP_NAME_PLACEHOLDER}`);
    expect(revealAppHint({ canCreateApps: true, appIds: null })).toContain("The app appears in Apps automatically");
  });

  it("names an allowed app for a key limited to apps", () => {
    expect(revealSnippet("k", { canCreateApps: false, appIds: [A2] }, slugs)).toBe("export APILENS_API_KEY=k\nexport APILENS_APP_ID=orders");
    expect(revealAppHint({ canCreateApps: false, appIds: [A2] })).toContain("any other app name is rejected");
    expect(revealAppHint({ canCreateApps: false, appIds: null })).toContain("doesn’t create apps");
  });
});

describe("keys pagination", () => {
  const many = Array.from({ length: 60 }, (_, i) => key({ id: `k${i}` }));

  it("slices 25 keys a page and keeps a page past the end out of the URL", () => {
    const { rows, window } = slicePage(many, parsePage({ page: "3" }, KEYS_PAGE));
    expect(rows).toHaveLength(10);
    expect(window.pages).toBe(3);
    expect(pageRedirect("/shop/settings/keys", { page: "7" }, 60, KEYS_PAGE)).toBe("/shop/settings/keys?page=3");
    expect(pageRedirect("/shop/settings/keys", { page: "2" }, 0, KEYS_PAGE)).toBe("/shop/settings/keys");
    expect(pageRedirect("/shop/settings/keys", {}, 25, KEYS_PAGE)).toBeNull();
  });
});
