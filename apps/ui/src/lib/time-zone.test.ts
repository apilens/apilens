import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, gmtOffset, isTimeZone, matchesZone, resolveTimeZone, sameDay, timeZoneOptions, zoneLabel, zoneOffsetMinutes, zoned, zonedParts } from "./time-zone";

const T = Date.parse("2026-11-05T22:40:12.345Z");

describe("time zones", () => {
  it("validates IANA names", () => {
    expect(isTimeZone("Asia/Kolkata")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(5)).toBe(false);
  });

  it("falls back to UTC", () => {
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone({})).toBe("UTC");
    expect(resolveTimeZone({ timezone: "nope" })).toBe("UTC");
    expect(resolveTimeZone({ timezone: "Asia/Kolkata" })).toBe("Asia/Kolkata");
  });

  it("formats in the zone", () => {
    const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    expect(zoned("en-US", opts, "UTC").format(T)).toBe("22:40");
    expect(zoned("en-US", opts, "Asia/Kolkata").format(T)).toBe("04:10");
    expect(zoned("en-US", opts, "Asia/Kolkata")).toBe(zoned("en-US", opts, "Asia/Kolkata"));
  });

  it("splits an instant into wall-clock parts", () => {
    expect(zonedParts(T, "Asia/Kolkata")).toEqual({ year: 2026, month: 10, day: 6, hour: 4, minute: 10, second: 12, millisecond: 345 });
    expect(zonedParts(T, "UTC").day).toBe(5);
    expect(sameDay(T, Date.parse("2026-11-05T01:00:00Z"), "UTC")).toBe(true);
    expect(sameDay(T, Date.parse("2026-11-05T01:00:00Z"), "Asia/Kolkata")).toBe(false);
  });

  it("names offsets and zones", () => {
    expect(zoneOffsetMinutes("Asia/Kolkata", T)).toBe(330);
    expect(zoneOffsetMinutes("America/New_York", T)).toBe(-300);
    expect(gmtOffset(330)).toBe("GMT+5:30");
    expect(gmtOffset(-240)).toBe("GMT-4");
    expect(gmtOffset(0)).toBe("GMT");
    expect(zoneLabel("UTC", T)).toBe("UTC");
    expect(zoneLabel("Asia/Kolkata", T)).toBe("IST");
    expect(zoneLabel("America/New_York", T)).toBe("EST");
    expect(zoneLabel("Asia/Kathmandu", T)).toBe("GMT+5:45");
  });

  it("lists zones with UTC first and searches them", () => {
    const list = timeZoneOptions(T);
    expect(list[0].value).toBe("UTC");
    const kolkata = list.find((o) => o.value === "Asia/Kolkata");
    expect(kolkata).toMatchObject({ city: "Kolkata", region: "Asia", gmt: "GMT+5:30" });
    expect(kolkata && matchesZone(kolkata, "kolk")).toBe(true);
    expect(kolkata && matchesZone(kolkata, "ist")).toBe(true);
    expect(kolkata && matchesZone(kolkata, "+5:30")).toBe(true);
    expect(kolkata && matchesZone(kolkata, "berlin")).toBe(false);
  });
});
