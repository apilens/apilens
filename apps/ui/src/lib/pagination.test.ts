import { describe, expect, it } from "vitest";
import {
  DEFAULT_PER,
  clampPage,
  cursorHref,
  hrefWithoutPage,
  needsPagination,
  pageCount,
  pageForPer,
  pageHref,
  pageItems,
  pageOffset,
  pageWindow,
  parsePage,
  rangeText,
  slicePage,
  withoutPage,
} from "./pagination";

describe("parsePage", () => {
  it("defaults to page 1 at 25 a page", () => {
    expect(parsePage({})).toEqual({ page: 1, per: DEFAULT_PER });
    expect(DEFAULT_PER).toBe(25);
  });
  it("reads page and per", () => {
    expect(parsePage({ page: "3", per: "50" })).toEqual({ page: 3, per: 50 });
    expect(parsePage(new URLSearchParams("page=2&per=100"))).toEqual({ page: 2, per: 100 });
  });
  it("takes the first value of a repeated parameter", () => {
    expect(parsePage({ page: ["4", "9"] })).toEqual({ page: 4, per: 25 });
  });
  it.each(["0", "-2", "abc", "2.5", "1e3", "0x10", " 3", "", "9999999999"])("reads page %j as 1", (page) => {
    expect(parsePage({ page }).page).toBe(1);
  });
  it.each(["10", "30", "abc", "-25", "1000"])("reads an unknown per %j as the default", (per) => {
    expect(parsePage({ per }).per).toBe(25);
  });
  it("takes per-table sizes and default", () => {
    expect(parsePage({}, { sizes: [10, 20], defaultPer: 20 })).toEqual({ page: 1, per: 20 });
    expect(parsePage({ per: "10" }, { sizes: [10, 20], defaultPer: 20 }).per).toBe(10);
    expect(parsePage({ per: "25" }, { sizes: [10, 20], defaultPer: 20 }).per).toBe(20);
    // A default that is not one of the sizes falls back to the first size.
    expect(parsePage({}, { sizes: [10, 20], defaultPer: 15 }).per).toBe(10);
  });
});

describe("pageCount and clampPage", () => {
  it("counts pages", () => {
    expect(pageCount(0, 25)).toBe(0);
    expect(pageCount(1, 25)).toBe(1);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(312, 25)).toBe(13);
  });
  it("clamps a page beyond the last to the last", () => {
    expect(clampPage(99, 312, 25)).toBe(13);
  });
  it("is 1 with no rows or a page below 1", () => {
    expect(clampPage(5, 0, 25)).toBe(1);
    expect(clampPage(0, 100, 25)).toBe(1);
    expect(clampPage(Number.NaN, 100, 25)).toBe(1);
  });
  it("gives the API offset", () => {
    expect(pageOffset({ page: 3, per: 25 })).toBe(50);
    expect(pageOffset({ page: 0, per: 25 })).toBe(0);
  });
});

describe("pageWindow", () => {
  it("describes the page", () => {
    expect(pageWindow({ page: 2, per: 25 }, 312)).toEqual({ page: 2, per: 25, total: 312, pages: 13, start: 25, end: 50, from: 26, to: 50, hasPrev: true, hasNext: true });
  });
  it("ends the last page at the total", () => {
    const w = pageWindow({ page: 13, per: 25 }, 312);
    expect([w.from, w.to, w.hasNext]).toEqual([301, 312, false]);
  });
  it("clamps when the total shrinks while live-polling, keeping the page otherwise", () => {
    expect(pageWindow({ page: 5, per: 25 }, 312).page).toBe(5);
    expect(pageWindow({ page: 5, per: 25 }, 80).page).toBe(4);
    expect(pageWindow({ page: 5, per: 25 }, 400).page).toBe(5);
  });
  it("has no rows and no controls at total 0", () => {
    const w = pageWindow({ page: 3, per: 25 }, 0);
    expect(w).toMatchObject({ page: 1, pages: 0, from: 0, to: 0, hasPrev: false, hasNext: false });
    expect(needsPagination(w)).toBe(false);
    expect(rangeText(w)).toBe("");
  });
  it("hides the controls when everything fits on one page", () => {
    expect(needsPagination(pageWindow({ page: 1, per: 25 }, 25))).toBe(false);
    expect(needsPagination(pageWindow({ page: 1, per: 25 }, 26))).toBe(true);
  });
});

describe("rangeText", () => {
  it("writes the range", () => {
    expect(rangeText(pageWindow({ page: 2, per: 25 }, 312))).toBe("Showing 26–50 of 312");
    expect(rangeText(pageWindow({ page: 1, per: 100 }, 12_345))).toBe("Showing 1–100 of 12,345");
  });
});

describe("slicePage", () => {
  const rows = Array.from({ length: 60 }, (_, i) => i);
  it("slices the page", () => {
    expect(slicePage(rows, { page: 2, per: 25 }).rows).toEqual(rows.slice(25, 50));
  });
  it("clamps to the last page", () => {
    const { rows: page, window } = slicePage(rows, { page: 9, per: 25 });
    expect(page).toEqual(rows.slice(50));
    expect(window.page).toBe(3);
  });
  it("is empty for no rows", () => {
    expect(slicePage([], { page: 1, per: 25 }).rows).toEqual([]);
  });
});

describe("pageItems", () => {
  it("lists every page when there are few", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageItems(1, 0)).toEqual([]);
  });
  it("puts gaps around the current page", () => {
    expect(pageItems(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
  });
  it("keeps a stable length near either end", () => {
    expect(pageItems(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageItems(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageItems(5, 20)).toEqual([1, "gap", 4, 5, 6, "gap", 20]);
    expect(pageItems(17, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
    expect(pageItems(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });
  it("never hides a single page behind a gap", () => {
    for (let pages = 1; pages <= 30; pages++) {
      for (let page = 1; page <= pages; page++) {
        const items = pageItems(page, pages);
        expect(items).toContain(page);
        items.forEach((it, i) => {
          if (it !== "gap") return;
          const before = items[i - 1] as number;
          const after = items[i + 1] as number;
          expect(after - before).toBeGreaterThan(2);
        });
      }
    }
  });
  it("clamps an out-of-range current page", () => {
    expect(pageItems(99, 3)).toEqual([1, 2, 3]);
  });
});

describe("pageForPer", () => {
  it("keeps the first visible row in view", () => {
    // Rows 51–75 at 25 a page; at 50 a page row 51 is on page 2, at 100 on page 1.
    const w = pageWindow({ page: 3, per: 25 }, 312);
    expect(pageForPer(w, 50)).toBe(2);
    expect(pageForPer(w, 100)).toBe(1);
    expect(pageForPer(pageWindow({ page: 1, per: 25 }, 0), 50)).toBe(1);
  });
});

describe("hrefs", () => {
  const params = { range: "7d", env: "production", page: "3", per: "50" };
  it("moves to another page, keeping the rest", () => {
    expect(pageHref("/demo/traffic", params, { page: 4 })).toBe("/demo/traffic?range=7d&env=production&page=4&per=50");
  });
  it("leaves page 1 and the default size out", () => {
    expect(pageHref("/demo/traffic", params, { page: 1 })).toBe("/demo/traffic?range=7d&env=production&per=50");
    expect(pageHref("/demo/traffic", params, { page: 1, per: 25 })).toBe("/demo/traffic?range=7d&env=production");
    expect(pageHref("/demo/traffic", {}, { page: 1 })).toBe("/demo/traffic");
  });
  it("honours a per-table default size", () => {
    expect(pageHref("/x", {}, { per: 50 }, { defaultPer: 50 })).toBe("/x");
    expect(pageHref("/x", {}, { per: 25 }, { defaultPer: 50 })).toBe("/x?per=25");
  });
  it("drops page when a filter, range or sort changes", () => {
    expect(withoutPage(params).toString()).toBe("range=7d&env=production&per=50");
    expect(hrefWithoutPage("/demo/traffic", params, { range: "1h" })).toBe("/demo/traffic?range=1h&env=production&per=50");
    expect(hrefWithoutPage("/demo/traffic", params, { env: null, sort: "p95" })).toBe("/demo/traffic?range=7d&per=50&sort=p95");
    expect(hrefWithoutPage("/demo/traffic", new URLSearchParams("page=2"))).toBe("/demo/traffic");
  });
  it("keeps repeated parameters", () => {
    expect(pageHref("/x", { status: ["4xx", "5xx"] }, { page: 2 })).toBe("/x?status=4xx&status=5xx&page=2");
  });
  it("builds cursor links with only one direction", () => {
    expect(cursorHref("/x", { after: "a1", page: "2", env: "prod" }, { before: "b9" })).toBe("/x?env=prod&before=b9");
    expect(cursorHref("/x", { before: "b9" }, { after: "a1" }, { before: "newer", after: "older" })).toBe("/x?before=b9&older=a1");
  });
});
