import { describe, expect, it } from "vitest";
import { indexAt, keepIndex, moveIndex, pointX, tooltipLeft, tooltipText } from "./chart-hover";

describe("indexAt", () => {
  it("finds the bar slot under x", () => {
    expect(indexAt(0, 100, 4, "slot")).toBe(0);
    expect(indexAt(24.9, 100, 4, "slot")).toBe(0);
    expect(indexAt(25, 100, 4, "slot")).toBe(1);
    expect(indexAt(99.9, 100, 4, "slot")).toBe(3);
  });
  it("finds the nearest line point", () => {
    // 5 points at 0, 25, 50, 75, 100
    expect(indexAt(12, 100, 5, "point")).toBe(0);
    expect(indexAt(13, 100, 5, "point")).toBe(1);
    expect(indexAt(100, 100, 5, "point")).toBe(4);
  });
  it("clamps outside the plot", () => {
    expect(indexAt(-20, 100, 5, "point")).toBe(0);
    expect(indexAt(400, 100, 5, "slot")).toBe(4);
  });
  it("handles no points, one point and an unmeasured plot", () => {
    expect(indexAt(10, 100, 0, "slot")).toBeNull();
    expect(indexAt(80, 100, 1, "point")).toBe(0);
    expect(indexAt(80, 0, 5, "point")).toBe(0);
    expect(indexAt(Number.NaN, 100, 5, "point")).toBeNull();
  });
});

describe("pointX", () => {
  it("places bar centres and line vertices", () => {
    expect(pointX(0, 100, 4, "slot")).toBe(12.5);
    expect(pointX(3, 100, 4, "slot")).toBe(87.5);
    expect(pointX(0, 120, 5, "point")).toBe(0);
    expect(pointX(4, 120, 5, "point")).toBe(120);
    expect(pointX(0, 120, 1, "point")).toBe(0);
    expect(pointX(0, 120, 0, "point")).toBe(0);
  });
  it("round-trips with indexAt", () => {
    for (const layout of ["slot", "point"] as const) {
      for (let i = 0; i < 7; i++) expect(indexAt(pointX(i, 333, 7, layout), 333, 7, layout)).toBe(i);
    }
  });
});

describe("moveIndex", () => {
  it("starts at the latest point on the first arrow", () => {
    expect(moveIndex("ArrowLeft", null, 10)).toBe(9);
    expect(moveIndex("ArrowRight", null, 10)).toBe(9);
  });
  it("steps and stops at either end", () => {
    expect(moveIndex("ArrowLeft", 5, 10)).toBe(4);
    expect(moveIndex("ArrowRight", 5, 10)).toBe(6);
    expect(moveIndex("ArrowLeft", 0, 10)).toBe(0);
    expect(moveIndex("ArrowRight", 9, 10)).toBe(9);
  });
  it("jumps", () => {
    expect(moveIndex("Home", 5, 10)).toBe(0);
    expect(moveIndex("End", 2, 10)).toBe(9);
    expect(moveIndex("PageDown", 50, 100)).toBe(40);
    expect(moveIndex("PageUp", 95, 100)).toBe(99);
  });
  it("ignores other keys and empty charts", () => {
    expect(moveIndex("a", 3, 10)).toBeNull();
    expect(moveIndex("ArrowLeft", 3, 0)).toBeNull();
  });
});

describe("keepIndex", () => {
  it("keeps the point when the data grows and clamps when it shrinks", () => {
    expect(keepIndex(5, 20)).toBe(5);
    expect(keepIndex(5, 3)).toBe(2);
    expect(keepIndex(5, 0)).toBeNull();
    expect(keepIndex(null, 10)).toBeNull();
  });
});

describe("tooltipLeft", () => {
  it("centres on the anchor", () => {
    expect(tooltipLeft(100, 40, 300)).toBe(80);
  });
  it("stays inside both edges", () => {
    expect(tooltipLeft(5, 40, 300)).toBe(0);
    expect(tooltipLeft(295, 40, 300)).toBe(260);
  });
  it("starts at the left edge when wider than the box", () => {
    expect(tooltipLeft(50, 400, 300)).toBe(0);
  });
});

describe("tooltipText", () => {
  it("joins the title and every series", () => {
    expect(tooltipText("Mar 4, 14:00 UTC", [{ label: "4xx", value: "12" }, { label: "5xx", value: "3" }])).toBe("Mar 4, 14:00 UTC. 4xx: 12, 5xx: 3");
  });
  it("leaves out an empty label", () => {
    expect(tooltipText("Mar 4, 14:00 UTC", [{ label: "", value: "1,204 requests" }])).toBe("Mar 4, 14:00 UTC. 1,204 requests");
  });
});
