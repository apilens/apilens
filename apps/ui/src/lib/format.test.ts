import { describe, expect, it } from "vitest";

import { formatPercent, ratio } from "./format";

describe("formatPercent", () => {
  it("renders one decimal by default", () => {
    expect([0.125, 0.25, 0.13, 1, 0.0237].map((v) => formatPercent(v))).toEqual(["12.5%", "25.0%", "13.0%", "100.0%", "2.4%"]);
  });

  it("shows <0.1% for a tiny non-zero value and 0% for zero", () => {
    expect(formatPercent(0.0004)).toBe("<0.1%");
    expect(formatPercent(0.000999)).toBe("<0.1%");
    expect(formatPercent(0.001)).toBe("0.1%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("treats negative and non-finite values as 0%", () => {
    expect([-0.2, Number.NaN, Number.POSITIVE_INFINITY].map((v) => formatPercent(v))).toEqual(["0%", "0%", "0%"]);
  });

  it("takes the number of decimals", () => {
    expect(formatPercent(0.0025, { digits: 2 })).toBe("0.25%");
    expect(formatPercent(0.00004, { digits: 2 })).toBe("<0.01%");
    expect(formatPercent(0.297, { digits: 0 })).toBe("30%");
    expect(formatPercent(0.002, { digits: 0 })).toBe("<1%");
  });

  it("does not clamp above 100%", () => {
    expect(formatPercent(1.5)).toBe("150.0%");
  });
});

describe("ratio", () => {
  it("divides, and is 0 without a denominator", () => {
    expect(ratio(12, 500)).toBe(0.024);
    expect(ratio(3, 0)).toBe(0);
  });
});
