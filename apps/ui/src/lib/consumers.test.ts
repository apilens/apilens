import { describe, expect, it } from "vitest";
import {
  bucketTimes,
  consumerLabel,
  consumersHref,
  formatBucket,
  formatPerMinute,
  groupHref,
  niceMax,
  parseConsumersQuery,
  sparklinePoints,
  stackBars,
} from "./consumers";

const DEFAULTS = { range: "24h", from: "", to: "", env: "", app: "", method: "", path: "", groupLike: "", pathLike: "", status: "", group: null, consumer: null, tab: "requests", q: "", sort: "requests" };

describe("parseConsumersQuery", () => {
  it("defaults everything", () => {
    expect(parseConsumersQuery({})).toEqual(DEFAULTS);
  });

  it("reads known values and drops the rest", () => {
    expect(parseConsumersQuery({ range: "7d", group: " Acme Corp ", consumer: "usr_1f3a9c", tab: "errors", q: " priya ", sort: "last_seen" })).toEqual({
      range: "7d",
      from: "",
      to: "",
      env: "",
      app: "",
      method: "",
      path: "",
      groupLike: "",
      pathLike: "",
      status: "",
      group: "Acme Corp",
      consumer: "usr_1f3a9c",
      tab: "errors",
      q: "priya",
      sort: "last_seen",
    });
    expect(parseConsumersQuery({ range: "30d", group: "x".repeat(257), consumer: "x".repeat(257), tab: "y", q: "  ", sort: "p95" })).toEqual(DEFAULTS);
    expect(parseConsumersQuery({ range: ["6h", "7d"] }).range).toBe("6h");
  });

  it("reads the filter bar's app, method and endpoint, and only known sorts", () => {
    expect(parseConsumersQuery({ app: "5D0C1B2A-3E4F-4A5B-8C6D-7E8F9A0B1C2D", method: "post", path: "/orders/{id}" })).toMatchObject({
      app: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
      method: "POST",
      path: "/orders/{id}",
    });
    expect(parseConsumersQuery({ app: "nope", method: "GET1", path: "orders" })).toMatchObject({ app: "", method: "", path: "" });
    expect(parseConsumersQuery({ sort: "consumers" }).sort).toBe("requests");
  });
});

describe("consumersHref", () => {
  it("leaves defaults out but always carries the range (#993) and encodes the consumer", () => {
    expect(consumersHref("shop", {})).toBe("/project/shop/consumers");
    expect(consumersHref("shop", DEFAULTS as never)).toBe("/project/shop/consumers?range=24h&env=all");
    expect(consumersHref("shop", { range: "7d", consumer: "acme/eu 1", tab: "errors" })).toBe("/project/shop/consumers?range=7d&consumer=acme%2Feu+1&tab=errors");
    expect(consumersHref("shop", { group: "Acme Corp", q: "priya", sort: "errors" })).toBe("/project/shop/consumers?group=Acme+Corp&q=priya&sort=errors");
    expect(groupHref("shop", "Umbrella Health", "1h")).toBe("/project/shop/consumers?range=1h&group=Umbrella+Health");
  });

  it("drops what does not apply, and never carries a page", () => {
    expect(consumersHref("shop", { method: "POST", path: "/charge", sort: "requests" })).toBe("/project/shop/consumers?method=POST&path=%2Fcharge");
    expect(consumersHref("shop", { tab: "errors" })).toBe("/project/shop/consumers");
    // The drawer (consumer) opens over the list, which keeps its filters under it.
    expect(consumersHref("shop", { consumer: "u1", q: "x", group: "G", sort: "errors" })).toBe("/project/shop/consumers?group=G&q=x&sort=errors&consumer=u1");
    expect(consumersHref("shop", { page: 3 } as never)).toBe("/project/shop/consumers");
  });
});

describe("bucketTimes", () => {
  it("lists each bucket's start", () => {
    expect(bucketTimes("2026-11-05T14:00:00Z", 900, 3)).toEqual(["2026-11-05T14:00:00.000Z", "2026-11-05T14:15:00.000Z", "2026-11-05T14:30:00.000Z"]);
    expect(bucketTimes("", 900, 3)).toEqual([]);
    expect(bucketTimes("2026-11-05T14:00:00Z", 0, 3)).toEqual([]);
  });
});

describe("formatting", () => {
  it("labels consumers by name, else id", () => {
    expect(consumerLabel({ consumer_id: "c1", consumer_name: "Acme" })).toBe("Acme");
    expect(consumerLabel({ consumer_id: "c1", consumer_name: " " })).toBe("c1");
  });

  it("formats rates, per-minute and buckets", () => {
    expect(formatPerMinute(0)).toBe("0");
    expect(formatPerMinute(0.04)).toBe("<0.1");
    expect(formatPerMinute(2.44)).toBe("2.4");
    expect(formatPerMinute(1234.5)).toBe("1,235");
    expect(formatBucket("2026-11-05T14:05:00Z", "1h", "UTC")).toBe("14:05 UTC");
    expect(formatBucket("2026-11-05T14:00:00Z", "7d", "UTC")).toBe("Nov 5, 14:00 UTC");
    expect(formatBucket("nope", "1h", "UTC")).toBe("");
    expect(formatBucket("2026-11-05T14:05:00Z", "1h", "Asia/Kolkata")).toBe("19:35 IST");
    expect(formatBucket("2026-11-05T20:00:00Z", "7d", "Asia/Kolkata")).toBe("Nov 6, 01:30 IST");
  });

  it("rounds axis tops up", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(480)).toBe(500);
    expect(niceMax(1000)).toBe(1000);
  });
});

describe("stackBars", () => {
  it("stacks keys from the baseline with a 2px gap and skips zeros", () => {
    const { top, bars } = stackBars(
      [
        { returning: 6, new: 4 },
        { returning: 0, new: 2 },
        { returning: 0, new: 0 },
      ],
      ["returning", "new"],
      300,
      100,
    );
    expect(top).toBe(10);
    expect(bars.map((b) => b.total)).toEqual([10, 2, 0]);
    expect(bars[0]).toMatchObject({ x: 1, w: 98 });
    expect(bars[0].segments).toEqual([
      { key: "returning", y: 40, h: 60 },
      { key: "new", y: 0, h: 38 },
    ]);
    expect(bars[1].segments).toEqual([{ key: "new", y: 80, h: 20 }]);
    expect(bars[2].segments).toEqual([]);
  });
});

describe("sparklinePoints", () => {
  it("scales to the box with the baseline at the bottom", () => {
    expect(sparklinePoints([0, 5, 10], 100, 22)).toBe("0,21 50,11 100,1");
    expect(sparklinePoints([0, 0], 10, 10)).toBe("0,9 10,9");
    expect(sparklinePoints([], 10, 10)).toBe("");
  });
});

describe("environment", () => {
  it("reads an environment (all for none)", () => {
    expect(parseConsumersQuery({ env: " production " }).env).toBe("production");
    expect(parseConsumersQuery({ env: "all" }).env).toBe("");
    expect(parseConsumersQuery({ env: "x".repeat(65) }).env).toBe("");
  });
  it("writes it with the other filters", () => {
    expect(consumersHref("shop", { range: "24h", env: "production", group: "Partners" })).toBe("/project/shop/consumers?range=24h&env=production&group=Partners");
    expect(groupHref("shop", "Partners", "24h", "staging")).toBe("/project/shop/consumers?range=24h&env=staging&group=Partners");
  });
});

describe("contains and status", () => {
  it("reads and writes group_contains, path_contains and status", () => {
    const q = parseConsumersQuery({ group_contains: " part ", path_contains: "orders", status: "4XX,500" });
    expect(q).toMatchObject({ groupLike: "part", pathLike: "orders", status: "4xx,500" });
    expect(parseConsumersQuery({ status: "4xxx" }).status).toBe("");
    expect(consumersHref("shop", { range: "24h", groupLike: "part", pathLike: "orders", status: "4xx,500" })).toBe(
      "/project/shop/consumers?range=24h&path_contains=orders&status=4xx%2C500&group_contains=part",
    );
  });
});

describe("a picked window", () => {
  it("reads both ends in order and at most 7 days apart, else neither", () => {
    expect(parseConsumersQuery({ from: "2026-11-22T08:00:00Z", to: "2026-11-22T09:00:00Z" })).toMatchObject({ from: "2026-11-22T08:00:00Z", to: "2026-11-22T09:00:00Z" });
    expect(parseConsumersQuery({ from: "2026-11-22T09:00:00Z", to: "2026-11-22T08:00:00Z" })).toMatchObject({ from: "", to: "" });
    expect(parseConsumersQuery({ from: "2026-11-01T00:00:00Z", to: "2026-11-22T00:00:00Z" })).toMatchObject({ from: "", to: "" });
    expect(parseConsumersQuery({ from: "2026-11-22T08:00:00Z" })).toMatchObject({ from: "", to: "" });
  });
  it("writes it after the range", () => {
    expect(consumersHref("shop", { range: "24h", from: "2026-11-22T08:00:00Z", to: "2026-11-22T09:00:00Z", group: "Partners" })).toBe(
      "/project/shop/consumers?range=24h&from=2026-11-22T08%3A00%3A00Z&to=2026-11-22T09%3A00%3A00Z&group=Partners",
    );
  });
});
