import { describe, expect, it } from "vitest";
import {
  bucketTimes,
  consumerLabel,
  consumersHref,
  formatBucket,
  formatPerMinute,
  formatRate,
  groupHref,
  niceMax,
  parseConsumersQuery,
  sparklinePoints,
  stackBars,
} from "./consumers";

const DEFAULTS = { range: "24h", by: "consumers", group: null, consumer: null, tab: "requests", q: "", sort: "requests" };

describe("parseConsumersQuery", () => {
  it("defaults everything", () => {
    expect(parseConsumersQuery({})).toEqual(DEFAULTS);
  });

  it("reads known values and drops the rest", () => {
    expect(parseConsumersQuery({ range: "7d", group: " Acme Corp ", consumer: "usr_1f3a9c", tab: "errors", q: " priya ", sort: "last_seen" })).toEqual({
      range: "7d",
      by: "consumers",
      group: "Acme Corp",
      consumer: "usr_1f3a9c",
      tab: "errors",
      q: "priya",
      sort: "last_seen",
    });
    expect(parseConsumersQuery({ range: "30d", by: "x", group: "x".repeat(257), consumer: "x".repeat(257), tab: "y", q: "  ", sort: "p95" })).toEqual(DEFAULTS);
    expect(parseConsumersQuery({ range: ["6h", "7d"] }).range).toBe("6h");
  });

  it("sorts groups by users too, and never filters groups by a group", () => {
    expect(parseConsumersQuery({ by: "groups", sort: "consumers", group: "Initech" })).toMatchObject({ by: "groups", sort: "consumers", group: null });
    expect(parseConsumersQuery({ sort: "consumers" }).sort).toBe("requests");
  });
});

describe("consumersHref", () => {
  it("leaves defaults out and encodes the consumer", () => {
    expect(consumersHref("shop", {})).toBe("/shop/consumers");
    expect(consumersHref("shop", DEFAULTS as never)).toBe("/shop/consumers");
    expect(consumersHref("shop", { range: "7d", consumer: "acme/eu 1", tab: "errors" })).toBe("/shop/consumers?range=7d&consumer=acme%2Feu+1&tab=errors");
    expect(consumersHref("shop", { group: "Acme Corp", q: "priya", sort: "errors" })).toBe("/shop/consumers?group=Acme+Corp&q=priya&sort=errors");
    expect(groupHref("shop", "Umbrella Health", "1h")).toBe("/shop/consumers?range=1h&group=Umbrella+Health");
  });

  it("drops what does not apply, and never carries a page", () => {
    expect(consumersHref("shop", { by: "groups", group: "Initech", sort: "consumers" })).toBe("/shop/consumers?by=groups&sort=consumers");
    expect(consumersHref("shop", { sort: "consumers" })).toBe("/shop/consumers");
    expect(consumersHref("shop", { tab: "errors" })).toBe("/shop/consumers");
    expect(consumersHref("shop", { consumer: "u1", q: "x", group: "G", sort: "errors" })).toBe("/shop/consumers?consumer=u1");
    expect(consumersHref("shop", { page: 3 } as never)).toBe("/shop/consumers");
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
    expect(formatRate(0, 0)).toBe("0%");
    expect(formatRate(1, 2000)).toBe("<0.1%");
    expect(formatRate(12, 500)).toBe("2.4%");
    expect(formatPerMinute(0)).toBe("0");
    expect(formatPerMinute(0.04)).toBe("<0.1");
    expect(formatPerMinute(2.44)).toBe("2.4");
    expect(formatPerMinute(1234.5)).toBe("1,235");
    expect(formatBucket("2026-11-05T14:05:00Z", "1h")).toBe("14:05 UTC");
    expect(formatBucket("2026-11-05T14:00:00Z", "7d")).toBe("Nov 5, 14:00 UTC");
    expect(formatBucket("nope", "1h")).toBe("");
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
