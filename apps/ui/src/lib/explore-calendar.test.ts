import { describe, expect, it } from "vitest";
import { addDays, addMonths, clampPart, dayKey, dayLabel, monthGrid, moveDay, padPart, pickDay, stepPart, zonedDayTime, zonedInstant } from "./explore-calendar";

describe("the month grid", () => {
  it("draws November 2026 as react-day-picker does: five weeks from Sunday the 1st", () => {
    const g = monthGrid(2026, 10);
    expect(g).toHaveLength(5);
    expect(g[0].map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(g[4].map((d) => d.day)).toEqual([29, 30, 1, 2, 3, 4, 5]);
    expect(g[4].map((d) => d.outside)).toEqual([false, false, true, true, true, true, true]);
    expect(g[2][4]).toEqual({ key: "2026-11-19", day: 19, outside: false });
  });

  it("pads with the month before and adds a sixth week when needed", () => {
    const g = monthGrid(2026, 7); // August 2026 starts on a Saturday
    expect(g).toHaveLength(6);
    expect(g[0][0]).toEqual({ key: "2026-07-26", day: 26, outside: true });
    expect(g[0][6]).toEqual({ key: "2026-08-01", day: 1, outside: false });
  });
});

describe("day arithmetic", () => {
  it("rolls over months and years and clamps month ends", () => {
    expect(dayKey(2026, 12, 1)).toBe("2027-01-01");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-19", -12)).toBe("2025-11-19");
  });

  it("moves the calendar's focus by key", () => {
    expect(moveDay("2026-11-19", "ArrowLeft")).toBe("2026-11-18");
    expect(moveDay("2026-11-19", "ArrowDown")).toBe("2026-11-26");
    expect(moveDay("2026-11-19", "Home")).toBe("2026-11-15");
    expect(moveDay("2026-11-19", "End")).toBe("2026-11-21");
    expect(moveDay("2026-11-19", "PageUp")).toBe("2026-10-19");
    expect(moveDay("2026-11-19", "PageDown", true)).toBe("2027-11-19");
    expect(moveDay("2026-11-19", "a")).toBeNull();
  });

  it("picks a range: a first pick starts again, a second sets the other end", () => {
    expect(pickDay({ from: "2026-11-10", to: "2026-11-12" }, "2026-11-15")).toEqual({ from: "2026-11-15", to: null });
    expect(pickDay({ from: "2026-11-15", to: null }, "2026-11-18")).toEqual({ from: "2026-11-15", to: "2026-11-18" });
    expect(pickDay({ from: "2026-11-15", to: null }, "2026-11-13")).toEqual({ from: "2026-11-13", to: "2026-11-15" });
  });

  it("names a day for screen readers", () => {
    expect(dayLabel("2026-11-19")).toBe("Thursday, November 19, 2026");
  });
});

describe("times in the viewer's zone", () => {
  it("splits an instant into the zone's day and HH:MM:SS, and back", () => {
    const at = Date.parse("2026-11-19T07:37:05Z");
    expect(zonedDayTime(at, "Asia/Kolkata")).toEqual({ day: "2026-11-19", time: { hh: "13", mm: "07", ss: "05" } });
    expect(zonedDayTime(at, "America/Los_Angeles")).toEqual({ day: "2026-11-18", time: { hh: "23", mm: "37", ss: "05" } });
    expect(zonedInstant("2026-11-19", { hh: "13", mm: "07", ss: "05" }, "Asia/Kolkata")).toBe("2026-11-19T07:37:05Z");
    expect(zonedInstant("2026-11-19", { hh: "1", mm: "2", ss: "3" }, "UTC")).toBe("2026-11-19T01:02:03Z");
    expect(zonedInstant("2026-11-19", { hh: "", mm: "00", ss: "00" }, "UTC")).toBeNull();
  });

  it("keeps a typed part to two digits within its range", () => {
    expect(clampPart("7", 23)).toBe("7");
    expect(clampPart("99", 23)).toBe("23");
    expect(clampPart("125", 59)).toBe("25");
    expect(clampPart("a", 59)).toBe("");
    expect(padPart("7")).toBe("07");
    expect(padPart("")).toBe("00");
    expect(stepPart("23", 1, 23)).toBe("00");
    expect(stepPart("00", -1, 59)).toBe("59");
  });
});
