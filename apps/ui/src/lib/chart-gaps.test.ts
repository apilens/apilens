// Gap-aware chart geometry (M7 #1129): lines, bands and sparklines break at null buckets.
import { describe, expect, it } from "vitest";
import { bandPath, isolatedPoints, linePath, sparklinePath } from "./traffic";

describe("charts with gaps", () => {
  it("breaks the line at a null bucket and starts again after it", () => {
    expect(linePath([0, null, 10], 300, 100, 10)).toBe("M50,100M250,0");
    expect(linePath([0, 5, null, null, 10, 10], 600, 100, 10)).toBe("M50,100L150,50M450,0L550,0");
    expect(linePath([null, null], 100, 100, 10)).toBe("");
  });

  it("never draws a gap as zero", () => {
    expect(linePath([null, 5], 200, 100, 10)).not.toContain(",100");
  });

  it("fills one closed shape per run of buckets with both bounds", () => {
    // Two buckets: along max forwards, back along min.
    expect(bandPath([2, 4], [6, 8], 200, 100, 10)).toBe("M50,40L150,20L150,60L50,80Z");
    // A gap ends a run; a lone bucket is a sliver a quarter slot each side.
    expect(bandPath([2, null, 4], [6, null, 8], 300, 100, 10)).toBe("M25,40L75,40L75,80L25,80ZM225,20L275,20L275,60L225,60Z");
    expect(bandPath([2, 3], [null, 5], 200, 100, 10)).toBe("M125,50L175,50L175,70L125,70Z");
    expect(bandPath([], [], 100, 100, 10)).toBe("");
  });

  it("finds the lone buckets a line cannot draw", () => {
    expect(isolatedPoints([1, null, 2, 3, null, 4])).toEqual([0, 5]);
    expect(isolatedPoints([null, 1, null])).toEqual([1]);
    expect(isolatedPoints([1, 2])).toEqual([]);
  });

  it("draws sparklines with gaps, a lone point as a dot, against a fixed top", () => {
    expect(sparklinePath([], 120, 24)).toBe("");
    expect(sparklinePath([null, null], 120, 24)).toBe("");
    expect(sparklinePath([0, 100, null, 50], 120, 24, 100)).toBe("M0,23L40,1M120,12h0");
    // Without a top the largest value is the top.
    expect(sparklinePath([5, 10], 100, 24)).toBe("M0,12L100,1");
  });
});
