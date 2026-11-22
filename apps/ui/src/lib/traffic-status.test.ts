import { describe, expect, it } from "vitest";
import { codeOn, levelState, statusTerms, statusText, toggleCode, toggleLevel } from "./traffic-status";

const SUCCESS = ["2xx", "3xx"];

describe("traffic status filter", () => {
  it("reads terms without repeats", () => {
    expect(statusTerms("4xx,404,4xx")).toEqual(["4xx", "404"]);
    expect(statusTerms("")).toEqual([]);
    expect(statusTerms(undefined)).toEqual([]);
  });

  it("ticks and unticks levels, folding their single codes in", () => {
    expect(toggleLevel("", ["4xx"])).toBe("4xx");
    expect(toggleLevel("4xx", ["5xx"])).toBe("4xx,5xx");
    expect(toggleLevel("4xx,5xx", ["4xx"])).toBe("5xx");
    expect(toggleLevel("404,500", ["4xx"])).toBe("500,4xx");
    expect(toggleLevel("", SUCCESS)).toBe("2xx,3xx");
    expect(toggleLevel("2xx,3xx,5xx", SUCCESS)).toBe("5xx");
  });

  it("says when a level is on, partly on or off", () => {
    expect(levelState("4xx", ["4xx"])).toBe("on");
    expect(levelState("404", ["4xx"])).toBe("partial");
    expect(levelState("2xx", SUCCESS)).toBe("partial");
    expect(levelState("2xx,3xx", SUCCESS)).toBe("on");
    expect(levelState("500", ["4xx"])).toBe("off");
  });

  it("ticks and unticks codes, keeping a ticked class's other codes", () => {
    const known = ["400", "404", "422", "500"];
    expect(toggleCode("", "404", known)).toBe("404");
    expect(toggleCode("404", "500", known)).toBe("404,500");
    expect(toggleCode("404,500", "404", known)).toBe("500");
    expect(toggleCode("4xx", "404", known)).toBe("400,422");
    expect(toggleCode("4xx,500", "422", known)).toBe("500,400,404");
  });

  it("knows a code is in through its class", () => {
    expect(codeOn("4xx", "404")).toBe(true);
    expect(codeOn("404", "404")).toBe(true);
    expect(codeOn("500", "404")).toBe(false);
  });

  it("says the filter in words", () => {
    expect(statusText("2xx,3xx,404")).toBe("2xx–3xx, 404");
    expect(statusText("4xx,500")).toBe("4xx, 500");
  });
});
