import { describe, expect, it } from "vitest";
import {
  APPS_PAGE,
  activeApps,
  appActionError,
  canDelete,
  canRestore,
  cardApps,
  checkAppName,
  doneText,
  inactiveApps,
  isManagedAppId,
  lastDataText,
  mergeExplainer,
  mergeTargets,
  newApps,
  originText,
  rejectionFixes,
  rejectionHeadline,
  rejectionLine,
  rejectionRows,
  shortDay,
  stateText,
} from "./app-manage";
import type { AppRejection, ManagedApp } from "./identity";
import { pageRedirect, parsePage, slicePage } from "./pagination";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

let n = 0;
const app = (over: Partial<ManagedApp> = {}): ManagedApp => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    slug: `app-${n}`,
    name: `App ${n}`,
    state: "active",
    created_by: "sdk",
    created_by_key_id: null,
    created_by_key_name: null,
    created_at: "2026-11-06T09:00:00Z",
    first_seen_at: "2026-11-06T09:00:00Z",
    last_seen_at: null,
    archived_at: null,
    deleted_at: null,
    restorable_until: null,
    acknowledged_at: null,
    new: false,
    is_default: false,
    merged_into: null,
    merged_into_slug: null,
    ...over,
  };
};

describe("isManagedAppId", () => {
  it("accepts UUIDs only", () => {
    expect(isManagedAppId("7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isManagedAppId("checkout-api")).toBe(false);
    expect(isManagedAppId(undefined)).toBe(false);
  });
});

describe("lists", () => {
  const def = app({ name: "shop", is_default: true });
  const orders = app({ name: "orders" });
  const billing = app({ name: "Billing" });
  const fresh = app({ name: "ordrs", new: true });
  const dashNew = app({ name: "manual", created_by: "dashboard", new: true });
  const archived = app({ name: "legacy", state: "archived", archived_at: "2026-11-01T00:00:00Z", new: true });
  const merged = app({ name: "old", state: "merged", archived_at: "2026-11-03T00:00:00Z" });
  const deleted = app({ name: "gone", state: "deleted", deleted_at: "2026-11-05T00:00:00Z" });
  const all = [orders, archived, billing, def, fresh, merged, deleted, dashNew];

  it("puts the default app first, then active apps by name", () => {
    expect(activeApps(all).map((a) => a.name)).toEqual(["shop", "Billing", "manual", "orders", "ordrs"]);
  });

  it("lists archived, merged and deleted apps, most recently changed first", () => {
    expect(inactiveApps(all).map((a) => a.name)).toEqual(["gone", "old", "legacy"]);
  });

  it("flags only active apps an SDK created as new", () => {
    expect(newApps(all).map((a) => a.name)).toEqual(["ordrs"]);
  });

  it("offers other active apps as merge targets", () => {
    expect(mergeTargets(all, fresh).map((a) => a.name)).toEqual(["shop", "Billing", "manual", "orders"]);
    expect(mergeTargets([fresh], fresh)).toEqual([]);
  });

  it("shows managed active apps, else the query role's list, else nothing", () => {
    expect(cardApps(all, null)?.map((a) => a.name)).toEqual(["shop", "Billing", "manual", "orders", "ordrs"]);
    expect(cardApps(null, [{ id: "a", slug: "a", name: "A" }])).toEqual([{ id: "a", slug: "a", name: "A" }]);
    expect(cardApps(null, null)).toBeNull();
    expect(cardApps([], [{ id: "a", slug: "a", name: "A" }])).toEqual([]);
  });
});

describe("pagination of the cards", () => {
  const many = Array.from({ length: 30 }, () => app());

  it("slices 12 cards a page by default and keeps the rest", () => {
    const first = slicePage(activeApps(many), parsePage({}, APPS_PAGE));
    expect(first.rows).toHaveLength(12);
    expect(first.window.pages).toBe(3);
    const last = slicePage(activeApps(many), parsePage({ page: "3" }, APPS_PAGE));
    expect(last.rows).toHaveLength(6);
  });

  it("redirects a page past the end to the last page, and any page of an empty list to page 1", () => {
    expect(pageRedirect("/shop/apps", { page: "9" }, 30, APPS_PAGE)).toBe("/shop/apps?page=3");
    // The only card on page 3 was archived: page 3 no longer exists.
    expect(pageRedirect("/shop/apps", { page: "3" }, 24, APPS_PAGE)).toBe("/shop/apps?page=2");
    expect(pageRedirect("/shop/apps", { page: "2", per: "24" }, 0, APPS_PAGE)).toBe("/shop/apps?per=24");
    expect(pageRedirect("/shop/apps", { page: "2" }, 30, APPS_PAGE)).toBeNull();
    expect(pageRedirect("/shop/apps", {}, 0, APPS_PAGE)).toBeNull();
  });
});

describe("shortDay", () => {
  it("leaves out this year's year", () => {
    expect(shortDay("2026-11-06T09:00:00Z", NOW)).toBe("Nov 6");
    expect(shortDay("2025-12-31T23:00:00Z", NOW)).toBe("Dec 31, 2025");
    expect(shortDay(null, NOW)).toBe("");
    expect(shortDay("nope", NOW)).toBe("");
  });
});

describe("originText", () => {
  it("names the key an SDK created the app with", () => {
    expect(originText(app({ created_by_key_name: "prod-backend" }), NOW)).toBe("Added by the SDK from key prod-backend · Nov 6");
  });

  it("says the SDK added it when no key is recorded", () => {
    expect(originText(app(), NOW)).toBe("Added by the SDK · Nov 6");
  });

  it("says when a person added it in the dashboard", () => {
    expect(originText(app({ created_by: "dashboard", created_at: "2026-10-02T10:00:00Z" }), NOW)).toBe("Added in the dashboard · Oct 2");
  });
});

describe("lastDataText", () => {
  it("says how long ago data last arrived", () => {
    expect(lastDataText(null, NOW)).toBe("No data yet");
    expect(lastDataText(iso(NOW - 20_000), NOW)).toBe("Last data just now");
    expect(lastDataText(iso(NOW - 5 * 60_000), NOW)).toBe("Last data 5 min ago");
    expect(lastDataText(iso(NOW - 3 * 3_600_000), NOW)).toBe("Last data 3 h ago");
    expect(lastDataText(iso(NOW - DAY), NOW)).toBe("Last data 1 day ago");
  });
});

describe("restore and delete", () => {
  it("restores archived and merged apps, and deleted ones until their name is released", () => {
    expect(canRestore(app({ state: "archived" }), NOW)).toBe(true);
    expect(canRestore(app({ state: "merged" }), NOW)).toBe(true);
    expect(canRestore(app({ state: "deleted", restorable_until: iso(NOW + DAY) }), NOW)).toBe(true);
    expect(canRestore(app({ state: "deleted", restorable_until: iso(NOW - 1) }), NOW)).toBe(false);
    expect(canRestore(app({ state: "deleted" }), NOW)).toBe(false);
    expect(canRestore(app(), NOW)).toBe(false);
  });

  it("deletes archived apps only, never the default app", () => {
    expect(canDelete(app({ state: "archived" }))).toBe(true);
    expect(canDelete(app({ state: "archived", is_default: true }))).toBe(false);
    expect(canDelete(app())).toBe(false);
    expect(canDelete(app({ state: "deleted" }))).toBe(false);
  });

  it("explains each inactive state", () => {
    expect(stateText(app({ state: "archived", archived_at: "2026-11-02T00:00:00Z" }), NOW)).toBe("Archived Nov 2. It comes back on its own when its SDK sends data again.");
    expect(stateText(app({ slug: "ordrs", state: "merged", merged_into_slug: "orders" }), NOW)).toBe(
      "Merged into orders. New data for ordrs goes there; earlier data stays under ordrs.",
    );
    expect(stateText(app({ slug: "gone", state: "deleted", deleted_at: "2026-11-05T00:00:00Z", restorable_until: "2026-12-05T00:00:00Z" }), NOW)).toBe(
      "Deleted Nov 5. Data for gone is rejected until Dec 5; restore it before then to keep the name.",
    );
    expect(stateText(app({ slug: "gone", state: "deleted", restorable_until: iso(NOW - 1) }), NOW)).toBe("Deleted. It can no longer be restored, and the name gone is free again.");
    expect(stateText(app(), NOW)).toBe("");
  });
});

describe("checkAppName", () => {
  it("trims and bounds the name", () => {
    expect(checkAppName("  Orders API ")).toEqual({ ok: true, name: "Orders API" });
    expect(checkAppName("   ")).toEqual({ ok: false, error: "Enter a name." });
    expect(checkAppName("x".repeat(101))).toEqual({ ok: false, error: "Use at most 100 characters." });
  });
});

describe("merge copy", () => {
  it("says past data stays and only future data moves", () => {
    const text = mergeExplainer({ slug: "ordrs" }, { name: "Orders API" });
    expect(text).toContain("From now on, data an SDK sends as ordrs goes to Orders API.");
    expect(text).toContain("Data already received stays under ordrs; it is not moved or rewritten.");
    expect(mergeExplainer({ slug: "ordrs" }, null)).toContain("goes to the app you pick");
  });

  it("announces each write", () => {
    expect(doneText("merge", { name: "ordrs" }, { name: "Orders API" })).toBe("Merged ordrs into Orders API. Its new data goes there from now on.");
    expect(doneText("acknowledge", { name: "orders" })).toBe("Kept orders.");
    expect(doneText("delete", { name: "legacy" })).toContain("rejected for 30 days");
  });
});

describe("appActionError", () => {
  it("uses the problem's detail where the API explains the refusal", () => {
    expect(appActionError("invalid_request", "The default app receives records that name no app; it cannot be archived, merged or deleted.")).toBe(
      "The default app receives records that name no app; it cannot be archived, merged or deleted.",
    );
    expect(appActionError("slug_taken", "A newer app uses this app's slug; rename or delete it first.")).toBe("A newer app uses this app's slug; rename or delete it first.");
    expect(appActionError("slug_taken")).toBe("A newer app uses this app’s name. Rename or delete that app first.");
  });

  it("maps the other codes to sentences", () => {
    expect(appActionError("forbidden", "Forbidden")).toBe("You don’t have permission to manage this project’s apps. Ask a project admin.");
    expect(appActionError("network_error")).toBe("We couldn’t reach APILens. Check your connection and try again.");
    expect(appActionError("server_error")).toBe("Something went wrong. Try again in a moment.");
  });
});

describe("rejections", () => {
  const rows: AppRejection[] = [
    { app: "billing", reason: "app_deleted", records: 12, last_day: "2026-11-05" },
    { app: "orders-api", reason: "app_create_forbidden", records: 1204, last_day: "2026-11-06" },
    { app: "noise", reason: "app_limit", records: 0, last_day: "2026-11-06" },
    { app: "orders-v2", reason: "app_create_forbidden", records: 1, last_day: "2026-11-06" },
  ];

  it("drops empty rows and puts the most records first", () => {
    expect(rejectionRows(rows).map((r) => r.app)).toEqual(["orders-api", "billing", "orders-v2"]);
    expect(rejectionRows(null)).toEqual([]);
  });

  it("totals the records over the days", () => {
    expect(rejectionHeadline(rejectionRows(rows), 7)).toBe("1,217 records were rejected in the last 7 days.");
    expect(rejectionHeadline([rows[3]], 1)).toBe("1 record was rejected today.");
  });

  it("says why per app", () => {
    expect(rejectionLine(rows[1], NOW)).toBe("orders-api: 1,204 records, the key can’t create apps (last Nov 6).");
    expect(rejectionLine(rows[3], NOW)).toBe("orders-v2: 1 record, the key can’t create apps (last Nov 6).");
  });

  it("lists each fix once", () => {
    const fixes = rejectionFixes(rejectionRows(rows));
    expect(fixes).toHaveLength(2);
    expect(fixes[0]).toContain("Turn on “Can create apps” for the key");
    expect(fixes[1]).toContain("Restore the app");
  });
});
