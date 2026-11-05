import { describe, expect, it } from "vitest";
import {
  checkGroupName,
  consumerLabel,
  consumersHref,
  formatBucket,
  formatPerMinute,
  formatRate,
  groupError,
  niceMax,
  parseConsumersQuery,
  rollupGroups,
  sparklinePoints,
  stackBars,
} from "./consumers";
import type { ConsumerGroup, ConsumerRow } from "./identity";

const GID = "0192f0c4-7a1b-7c3d-8e4f-5a6b7c8d9e0f";

describe("parseConsumersQuery", () => {
  it("defaults everything", () => {
    expect(parseConsumersQuery({})).toEqual({ range: "24h", by: "consumers", group: null, consumer: null, tab: "requests" });
  });

  it("reads known values and drops the rest", () => {
    expect(parseConsumersQuery({ range: "7d", by: "groups", group: GID.toUpperCase(), consumer: "acme", tab: "errors" })).toEqual({
      range: "7d",
      by: "groups",
      group: GID,
      consumer: "acme",
      tab: "errors",
    });
    expect(parseConsumersQuery({ range: "30d", by: "x", group: "nope", consumer: "x".repeat(257), tab: "y" })).toEqual(parseConsumersQuery({}));
    expect(parseConsumersQuery({ range: ["6h", "7d"] }).range).toBe("6h");
  });
});

describe("consumersHref", () => {
  it("leaves defaults out and encodes the consumer", () => {
    expect(consumersHref("shop", {})).toBe("/shop/consumers");
    expect(consumersHref("shop", { range: "24h", by: "consumers", tab: "requests" })).toBe("/shop/consumers");
    expect(consumersHref("shop", { range: "7d", consumer: "acme/eu 1", tab: "errors" })).toBe("/shop/consumers?range=7d&consumer=acme%2Feu+1&tab=errors");
    expect(consumersHref("shop", { group: GID })).toBe(`/shop/consumers?group=${GID}`);
  });

  it("drops the group filter and tab where they do not apply", () => {
    expect(consumersHref("shop", { by: "groups", group: GID })).toBe("/shop/consumers?by=groups");
    expect(consumersHref("shop", { tab: "errors" })).toBe("/shop/consumers");
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

describe("rollupGroups", () => {
  const group = (id: string, name: string): ConsumerGroup => ({ id, name, consumers: 0, created_at: "", updated_at: "" });
  const row = (id: string, groupId: string | null, requests: number, c4: number, c5: number, spark: number[]): ConsumerRow => ({
    consumer_id: id,
    consumer_name: id,
    group: groupId ? { id: groupId, name: groupId } : undefined,
    first_seen: "",
    last_seen: "",
    new: false,
    requests,
    successful: requests - c4 - c5,
    client_errors: c4,
    server_errors: c5,
    sparkline: spark,
  });

  it("sums each group's listed consumers, keeping empty groups", () => {
    const out = rollupGroups(
      [group("a", "Partners"), group("b", "Internal")],
      [row("c1", "a", 10, 1, 0, [4, 6]), row("c2", "a", 5, 0, 2, [5, 0]), row("c3", null, 99, 9, 9, [99, 0])],
    );
    expect(out.map((g) => [g.group.name, g.active, g.requests, g.client_errors, g.server_errors, g.sparkline])).toEqual([
      ["Partners", 2, 15, 1, 2, [9, 6]],
      ["Internal", 0, 0, 0, 0, []],
    ]);
  });
});

describe("groups", () => {
  it("checks names like the API", () => {
    expect(checkGroupName("  Partners ")).toEqual({ ok: true, name: "Partners" });
    expect(checkGroupName("   ").ok).toBe(false);
    expect(checkGroupName(42).ok).toBe(false);
    expect(checkGroupName("x".repeat(128)).ok).toBe(true);
    expect(checkGroupName("x".repeat(129)).ok).toBe(false);
  });

  it("says what went wrong", () => {
    expect(groupError("conflict")).toMatch(/already has a group/);
    expect(groupError("forbidden")).toMatch(/Ask a project admin/);
    expect(groupError("unavailable")).toMatch(/couldn’t reach/);
    expect(groupError("weird")).toMatch(/Something went wrong/);
  });
});
