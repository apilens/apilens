import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./identity";
import { deviceLabel, formatDateTime, hasOtherSessions, lastActive, orderSessions, sessionsError, signInMethod } from "./sessions";

function session(id: string, last: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    device_label: "Chrome on macOS",
    user_agent: "Mozilla/5.0",
    ip: "192.0.2.1",
    amr: ["email"],
    created_at: "2026-11-01T09:00:00Z",
    last_seen_at: last,
    expires_at: "2026-12-01T09:00:00Z",
    current: false,
    ...extra,
  };
}

describe("orderSessions", () => {
  it("pins the current session, then newest activity first", () => {
    const rows = orderSessions([
      session("a", "2026-11-03T10:00:00Z"),
      session("b", "2026-11-04T10:00:00Z"),
      session("c", "2026-11-01T10:00:00Z", { current: true }),
      session("d", "2026-11-04T11:00:00Z"),
    ]);
    expect(rows.map((s) => s.id)).toEqual(["c", "d", "b", "a"]);
  });

  it("breaks ties by sign-in time and does not mutate its input", () => {
    const input = [
      session("old", "2026-11-04T10:00:00Z", { created_at: "2026-10-01T00:00:00Z" }),
      session("new", "2026-11-04T10:00:00Z", { created_at: "2026-11-02T00:00:00Z" }),
    ];
    expect(orderSessions(input).map((s) => s.id)).toEqual(["new", "old"]);
    expect(input.map((s) => s.id)).toEqual(["old", "new"]);
  });
});

describe("hasOtherSessions", () => {
  it("is false when only the current session is left", () => {
    expect(hasOtherSessions([session("a", "2026-11-04T10:00:00Z", { current: true })])).toBe(false);
    expect(hasOtherSessions([session("a", "2026-11-04T10:00:00Z", { current: true }), session("b", "2026-11-04T10:00:00Z")])).toBe(true);
    expect(hasOtherSessions([])).toBe(false);
  });
});

describe("labels", () => {
  it("falls back for an empty device label", () => {
    expect(deviceLabel({ device_label: "Safari on iOS" })).toBe("Safari on iOS");
    expect(deviceLabel({ device_label: "  " })).toBe("Unknown device");
  });

  it("names the sign-in methods and skips unknown ones", () => {
    expect(signInMethod(["email", "totp"])).toBe("Email code + Authenticator app");
    expect(signInMethod(["passkey", "magic"])).toBe("Passkey");
    expect(signInMethod(["toString"])).toBe("");
    expect(signInMethod(null)).toBe("");
  });
});

describe("lastActive", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");

  it.each([
    ["2026-11-04T11:59:30Z", "Active now"],
    ["2026-11-04T12:00:10Z", "Active now"],
    ["2026-11-04T11:55:00Z", "5 minutes ago"],
    ["2026-11-04T10:00:00Z", "2 hours ago"],
    ["2026-11-03T11:00:00Z", "yesterday"],
    ["2026-10-14T12:00:00Z", "3 weeks ago"],
    ["not a date", "Unknown"],
  ])("%s is %s", (iso, text) => {
    expect(lastActive(iso, now)).toBe(text);
  });
});

describe("formatDateTime", () => {
  it("formats in UTC so server and browser agree", () => {
    expect(formatDateTime("2026-11-04T09:05:00Z")).toBe("Nov 4, 2026, 9:05 AM UTC");
    expect(formatDateTime("")).toBe("Unknown");
  });
});

describe("sessionsError", () => {
  it("has a sentence for every code", () => {
    expect(sessionsError("network_error")).toMatch(/couldn’t reach/);
    expect(sessionsError("rate_limited")).toMatch(/Wait a moment/);
    expect(sessionsError("bad_request")).toMatch(/Reload/);
    expect(sessionsError("whatever")).toMatch(/Something went wrong/);
  });
});
