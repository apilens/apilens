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
  STATE_LABEL,
  abilitiesText,
  filterKeys,
  formatDayMonth,
  inactiveCount,
  keyState,
  keyStateLabel,
  limitsText,
  parseKeyFilter,
  relativeTime,
  sdkText,
  DEFAULT_OVERLAP,
  EXPIRY_CHOICES,
  ROTATE_OVERLAPS,
  canRotate,
  checkEnvironments,
  formatDayTime,
  isRotateOverlap,
  overlapEnd,
  overlapText,
  pickableEnvironments,
  rotateError,
  rotatedText,
  withRotated,
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
  environments: null,
  last_used_ip: null,
  last_used_sdk: null,
  rate_limit_per_minute: null,
  rotated_from: null,
  rotated_to: null,
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

describe("key state (#810)", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

  it("names each state", () => {
    expect(keyState(key(), now)).toBe("active");
    expect(keyStateLabel(key(), now)).toBe("Active");
    expect(keyStateLabel(key({ expires_at: at(24 * 30) }), now)).toBe("Active");
    expect(keyState(key({ expires_at: at(24 * 5 + 2) }), now)).toBe("expiring");
    expect(keyStateLabel(key({ expires_at: at(24 * 5 + 2) }), now)).toBe("Expires in 5 days");
    expect(keyStateLabel(key({ expires_at: at(25) }), now)).toBe("Expires in 1 day");
    expect(keyStateLabel(key({ expires_at: at(3.5) }), now)).toBe("Expires in 3 hours");
    expect(keyStateLabel(key({ expires_at: at(0.2) }), now)).toBe("Expires in under an hour");
    expect(keyState(key({ expires_at: at(24 * 4 + 12), rotated_to: "x" }), now)).toBe("rotating");
    expect(keyStateLabel(key({ expires_at: "2026-11-14T00:00:00Z", rotated_to: "x" }), now)).toBe("Rotating until 14 Nov");
    expect(keyStateLabel(key({ expires_at: at(-1) }), now)).toBe("Expired");
    expect(keyStateLabel(key({ expires_at: at(-1), rotated_to: "x" }), now)).toBe("Expired");
    expect(keyStateLabel(key({ expires_at: at(-1), revoked_at: at(-2) }), now)).toBe("Revoked");
    expect(formatDayMonth("nope")).toBe("");
  });

  it("filters by state and hides inactive keys unless asked", () => {
    const list = [
      key({ id: "a" }),
      key({ id: "e", expires_at: at(48) }),
      key({ id: "r", expires_at: at(20), rotated_to: "a" }),
      key({ id: "x", expires_at: at(-5) }),
      key({ id: "v", revoked_at: at(-5) }),
    ];
    const ids = (f: Parameters<typeof filterKeys>[1]) => filterKeys(list, f, now).map((k) => k.id);
    expect(ids(parseKeyFilter({}))).toEqual(["a", "e", "r"]);
    expect(ids(parseKeyFilter({ inactive: "1" }))).toEqual(["a", "e", "r", "x", "v"]);
    expect(ids(parseKeyFilter({ state: "expiring" }))).toEqual(["e"]);
    expect(ids(parseKeyFilter({ state: "rotating" }))).toEqual(["r"]);
    expect(ids(parseKeyFilter({ state: "revoked" }))).toEqual(["v"]);
    expect(parseKeyFilter({ state: "expired" })).toEqual({ state: "expired", inactive: true });
    expect(parseKeyFilter(new URLSearchParams("state=bogus&inactive=yes"))).toEqual({ state: "all", inactive: false });
    expect(inactiveCount(list, now)).toBe(2);
    expect(STATE_LABEL.expiring).toBe("Expiring soon");
  });
});

describe("Can column (#810)", () => {
  const A1 = "11111111-1111-4111-8111-111111111111";
  const names = new Map([[A1, "Checkout API"]]);

  it("says what a key can do", () => {
    expect(abilitiesText(key())).toBe("Ingest and create apps");
    expect(abilitiesText(key({ scopes: ["ingest", "read"] }))).toBe("Ingest, create apps and read");
    expect(abilitiesText(key({ scopes: ["ingest"], can_create_apps: false }))).toBe("Ingest");
    expect(abilitiesText(key({ scopes: ["ingest"], app_ids: [A1] }))).toBe("Ingest");
    expect(abilitiesText(key({ scopes: ["read"] }))).toBe("Read");
    expect(abilitiesText(key({ scopes: [] }))).toBe("No access");
  });

  it("puts app and environment limits in words", () => {
    expect(limitsText(key(), names)).toBe("All apps · All environments");
    expect(limitsText(key({ app_ids: [A1], environments: ["production", "staging"] }), names)).toBe("Only Checkout API · Only production and staging");
    expect(limitsText(key({ app_ids: [] }), names)).toBe("No apps · All environments");
    expect(limitsText(key({ scopes: ["read"] }), names)).toBe("");
  });
});

describe("last used (#810)", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("reads relative time", () => {
    expect(relativeTime(ago(10_000), now)).toBe("Just now");
    expect(relativeTime(ago(60_000), now)).toBe("1 minute ago");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe("3 hours ago");
    expect(relativeTime(ago(30 * 3_600_000), now)).toBe("Yesterday");
    expect(relativeTime(ago(12 * 86_400_000), now)).toBe("12 days ago");
    expect(relativeTime("2026-08-01T10:00:00Z", now)).toBe("Aug 1, 2026");
    expect(relativeTime("bad", now)).toBe("");
  });

  it("shows the SDK and version", () => {
    expect(sdkText("apilenss/0.5.0")).toBe("apilenss 0.5.0");
    expect(sdkText(null)).toBe("");
  });
});

describe("rotation overlap (#811)", () => {
  const now = Date.parse("2026-11-13T10:30:00Z");
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

  it("offers Stop now, 24 hours and 7 days, 24 hours first chosen", () => {
    expect(ROTATE_OVERLAPS.map((o) => [o.value, o.label])).toEqual([
      ["none", "Stop now"],
      ["24h", "24 hours"],
      ["7d", "7 days"],
    ]);
    expect(DEFAULT_OVERLAP).toBe("24h");
    expect(isRotateOverlap("7d")).toBe(true);
    expect(isRotateOverlap("30d")).toBe(false);
    expect(isRotateOverlap("toString")).toBe(false);
    expect(isRotateOverlap(undefined)).toBe(false);
  });

  it("ends the overlap after the window, never past the key's own expiry", () => {
    expect(overlapEnd("none", null, now)).toBe(now);
    expect(overlapEnd("24h", null, now)).toBe(now + 86_400_000);
    expect(overlapEnd("7d", null, now)).toBe(now + 7 * 86_400_000);
    expect(overlapEnd("7d", at(48), now)).toBe(now + 48 * 3_600_000);
    expect(overlapEnd("24h", at(48), now)).toBe(now + 86_400_000);
  });

  it("says what happens to the old key", () => {
    expect(overlapText("none", null, now)).toBe("The old key stops working as soon as you rotate.");
    expect(overlapText("24h", null, now)).toBe("The old key keeps working until 14 Nov, 10:30 UTC.");
    expect(overlapText("7d", null, now)).toBe("The old key keeps working until 20 Nov, 10:30 UTC.");
    expect(overlapText("7d", "2026-11-15T00:00:00Z", now)).toBe("The old key keeps working until 15 Nov, 00:00 UTC, when it expires anyway.");
    expect(formatDayTime(Number.NaN)).toBe("");
  });

  it("rotates only working keys that were not rotated yet", () => {
    expect(canRotate(key(), now)).toBe(true);
    expect(canRotate(key({ expires_at: at(24) }), now)).toBe(true);
    expect(canRotate(key({ expires_at: at(24), rotated_to: "x" }), now)).toBe(false);
    expect(canRotate(key({ expires_at: at(-1) }), now)).toBe(false);
    expect(canRotate(key({ revoked_at: at(-1) }), now)).toBe(false);
  });

  it("reports the rotation and updates the list", () => {
    expect(rotatedText({ name: "Prod", expires_at: at(24) }, now)).toBe("Rotated Prod. The old key works until 14 Nov, 10:30 UTC.");
    expect(rotatedText({ name: "Prod", expires_at: at(0) }, now)).toBe("Rotated Prod. The old key no longer works.");
    const old = key({ id: "old" });
    const other = key({ id: "other" });
    const previous = { ...old, expires_at: at(24), rotated_to: "new" };
    const next = key({ id: "new", rotated_from: "old" });
    expect(withRotated([other, old], next, previous)).toEqual([next, other, previous]);
    expect(rotateError("key_not_active")).toMatch(/revoked, expired or rotated already/);
    expect(rotateError("forbidden")).toBe(apiKeysError("forbidden"));
  });
});

describe("environment limits (#811)", () => {
  it("offers the visible environments in the project's order", () => {
    const env = (name: string, position: number, hidden = false) => ({ name, position, hidden });
    expect(pickableEnvironments([env("staging", 1), env("qa", 2, true), env("production", 0)])).toEqual(["production", "staging"]);
    expect(pickableEnvironments([])).toEqual([]);
    expect(pickableEnvironments(null)).toBeNull();
  });

  it("checks the environments a Server Action received", () => {
    expect(checkEnvironments(undefined)).toEqual({ ok: true, environments: null });
    expect(checkEnvironments(null)).toEqual({ ok: true, environments: null });
    expect(checkEnvironments(["production", " production ", "staging"])).toEqual({ ok: true, environments: ["production", "staging"] });
    expect(checkEnvironments([])).toEqual({ ok: false, error: "Choose at least one environment, or allow every environment." });
    expect(checkEnvironments(["", "x"]).ok).toBe(false);
    expect(checkEnvironments("production").ok).toBe(false);
  });
});

describe("expiry choices (#811)", () => {
  it("offers never, 30, 90 and 365 days and a custom date", () => {
    expect(EXPIRY_CHOICES.map((c) => c.value)).toEqual(["never", "30", "90", "365", "custom"]);
    expect(expiryFor("90", "", NOW)).toEqual({ ok: true, expiresAt: "2027-02-02T12:00:00.000Z" });
  });
});
