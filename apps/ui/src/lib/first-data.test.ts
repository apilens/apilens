import { describe, expect, it } from "vitest";
import { formatAgo, formatCount, shownPath } from "./first-data";

describe("formatting", () => {
  it("formats counts", () => {
    expect(formatCount(12345)).toBe("12,345");
  });

  it("says how long ago a request was", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(formatAgo("2026-11-04T11:59:58Z", now)).toBe("just now");
    expect(formatAgo("2026-11-04T11:59:18Z", now)).toBe("42s ago");
    expect(formatAgo("2026-11-04T11:57:00Z", now)).toBe("3m ago");
    expect(formatAgo("2026-11-04T10:00:00Z", now)).toBe("2h ago");
    expect(formatAgo("2026-10-31T12:00:00Z", now)).toBe("4d ago");
    // A clock a little ahead of ours is still "just now".
    expect(formatAgo("2026-11-04T12:00:03Z", now)).toBe("just now");
    expect(formatAgo("not a date", now)).toBe("");
  });

  it("shows the URL as requested, else the route template", () => {
    expect(shownPath({ path: "/orders/{id}", raw_path: "/orders/42" })).toBe("/orders/42");
    expect(shownPath({ path: "/orders/{id}", raw_path: "" })).toBe("/orders/{id}");
  });
});
