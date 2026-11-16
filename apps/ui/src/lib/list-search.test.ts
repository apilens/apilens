import { describe, expect, it } from "vitest";
import { canonicalPageHref, countLine, matchesQuery, parseQuery, searchRows, withQuery } from "./list-search";
import { parsePage, slicePage } from "./pagination";

describe("parseQuery", () => {
  it("reads ?q= trimmed, from either kind of params", () => {
    expect(parseQuery({ q: "  ada  " })).toBe("ada");
    expect(parseQuery(new URLSearchParams("q=max%20m"))).toBe("max m");
    expect(parseQuery({ q: ["first", "second"] })).toBe("first");
  });
  it("is empty without a search", () => {
    expect(parseQuery({})).toBe("");
    expect(parseQuery(new URLSearchParams(""))).toBe("");
  });
  it("caps a long search", () => {
    expect(parseQuery({ q: "x".repeat(500) })).toHaveLength(200);
  });
});

describe("matchesQuery", () => {
  const fields = ["Ada Lovelace", "ada@example.com", "Admin"];
  it("matches every row on an empty search", () => {
    expect(matchesQuery("", fields)).toBe(true);
    expect(matchesQuery("   ", fields)).toBe(true);
  });
  it("ignores case and matches any field", () => {
    expect(matchesQuery("LOVE", fields)).toBe(true);
    expect(matchesQuery("example.com", fields)).toBe(true);
    expect(matchesQuery("admin", fields)).toBe(true);
  });
  it("needs every word, each in some field", () => {
    expect(matchesQuery("ada admin", fields)).toBe(true);
    expect(matchesQuery("ada viewer", fields)).toBe(false);
  });
  it("ignores accents", () => {
    expect(matchesQuery("zoe", ["Zoë Ångström"])).toBe(true);
    expect(matchesQuery("angstrom", ["Zoë Ångström"])).toBe(true);
  });
  it("skips missing fields", () => {
    expect(matchesQuery("x", [null, undefined, ""])).toBe(false);
  });
});

describe("searchRows", () => {
  const rows = [{ n: "Olive Owner" }, { n: "Ada Admin" }, { n: "Max Member" }];
  it("keeps the matching rows in order", () => {
    expect(searchRows(rows, "a", (r) => [r.n]).map((r) => r.n)).toEqual(["Ada Admin", "Max Member"]);
  });
  it("returns a copy of every row on an empty search", () => {
    const out = searchRows(rows, "", (r) => [r.n]);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });
});

describe("withQuery", () => {
  it("sets the search and goes back to page 1 when it changes", () => {
    expect(withQuery({ page: "3", per: "50" }, "ada").toString()).toBe("per=50&q=ada");
  });
  it("keeps the page when the search is the same", () => {
    expect(withQuery({ q: "ada", page: "2" }, " ada ").toString()).toBe("q=ada&page=2");
  });
  it("drops an empty search", () => {
    expect(withQuery({ q: "ada", page: "2" }, "").toString()).toBe("");
  });
});

describe("canonicalPageHref", () => {
  const path = "/orgs/acme/settings/members";
  it("is null when the URL names the page shown", () => {
    expect(canonicalPageHref(path, {}, { page: 1 })).toBeNull();
    expect(canonicalPageHref(path, { page: "2" }, { page: 2 })).toBeNull();
  });
  it("points at the last page when the list shrank under the reader", () => {
    // 51 members at 25 a page: page 3 holds one. Removing it leaves 50, two pages.
    const params = { page: "3", q: "a" };
    const { window } = slicePage(Array.from({ length: 50 }, (_, i) => i), parsePage(params));
    expect(window.page).toBe(2);
    expect(canonicalPageHref(path, params, window)).toBe(`${path}?page=2&q=a`);
  });
  it("drops the page when the list fits on page 1 again", () => {
    expect(canonicalPageHref(path, { page: "4", per: "50" }, { page: 1 })).toBe(`${path}?per=50`);
  });
  it("tidies a ?page=1 or a page that is not a number", () => {
    expect(canonicalPageHref(path, { page: "1" }, { page: 1 })).toBe(path);
    expect(canonicalPageHref(path, { page: "abc" }, { page: 1 })).toBe(path);
  });
  it("respects a table's own default size", () => {
    expect(canonicalPageHref(path, { page: "9", per: "10" }, { page: 2 }, { sizes: [10, 25], defaultPer: 10 })).toBe(`${path}?page=2&per=10`);
  });
});

describe("countLine", () => {
  it("counts the list", () => {
    expect(countLine(5, 5, "member", "members", "")).toBe("5 members");
    expect(countLine(1, 1, "member", "members", "")).toBe("1 member");
    expect(countLine(1234, 1234, "member", "members", "")).toBe("1,234 members");
  });
  it("says how many match while searching", () => {
    expect(countLine(2, 12, "member", "members", "ad")).toBe("2 of 12 members match");
    expect(countLine(0, 1, "pending invitation", "pending invitations", "x")).toBe("0 of 1 pending invitation match");
  });
});
