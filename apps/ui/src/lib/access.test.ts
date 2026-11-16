import { describe, expect, it } from "vitest";
import { ACCESS_TABS, accessHref, accessTab, accessTitle, movedKeysHref, visibleAccessTabs } from "./access";

describe("ACCESS_TABS", () => {
  it("lists Members, API keys and Activity in order", () => {
    expect(ACCESS_TABS.map((t) => t.label)).toEqual(["Members", "API keys", "Activity"]);
  });
});

describe("accessHref", () => {
  it("opens Members at /access and the others under it", () => {
    expect(ACCESS_TABS.map((t) => accessHref("shop", t))).toEqual(["/shop/access", "/shop/access/keys", "/shop/access/activity"]);
  });
});

describe("visibleAccessTabs", () => {
  it("shows Activity only with audit.read", () => {
    expect(visibleAccessTabs({ shop: ["project.read"] }, "shop").map((t) => t.slug)).toEqual(["", "keys"]);
    expect(visibleAccessTabs({ shop: ["project.read", "audit.read"] }, "shop").map((t) => t.slug)).toEqual(["", "keys", "activity"]);
  });

  it("fails closed for a project missing from the capabilities", () => {
    expect(visibleAccessTabs({ other: ["audit.read"] }, "shop").map((t) => t.slug)).toEqual(["", "keys"]);
    expect(visibleAccessTabs(null, "shop").map((t) => t.slug)).toEqual(["", "keys"]);
  });
});

describe("accessTab", () => {
  it("defaults to Members and finds tabs by slug", () => {
    expect(accessTab(undefined)?.label).toBe("Members");
    expect(accessTab([])?.label).toBe("Members");
    expect(accessTab(["keys"])?.label).toBe("API keys");
    expect(accessTab(["activity"])?.label).toBe("Activity");
  });

  it("is undefined for unknown, nested and hidden tabs", () => {
    expect(accessTab(["members"])).toBeUndefined();
    expect(accessTab(["keys", "x"])).toBeUndefined();
    expect(accessTab([""])).toBeUndefined();
    expect(accessTab(["activity"], visibleAccessTabs({ shop: ["project.read"] }, "shop"))).toBeUndefined();
  });
});

describe("accessTitle", () => {
  it("names the page and the project", () => {
    expect(accessTitle("Shop")).toBe("Access · Shop");
  });
});

describe("movedKeysHref", () => {
  it("keeps the query of the old keys path", () => {
    expect(movedKeysHref("/shop/access/keys", {})).toBe("/shop/access/keys");
    expect(movedKeysHref("/shop/access/keys", { page: "2", per: "50", x: undefined })).toBe("/shop/access/keys?page=2&per=50");
    expect(movedKeysHref("/shop/access/keys", { a: ["1", "2"] })).toBe("/shop/access/keys?a=1&a=2");
  });
});
