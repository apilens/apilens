import { describe, expect, it } from "vitest";
import {
  REMEMBERED_ACCOUNT_KEY,
  emailInitials,
  forgetAccount,
  readRememberedAccount,
  relativeDay,
  rememberAccount,
} from "./remembered-account";

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const blocked = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("remembered account storage", () => {
  it("round-trips email and timestamp, and 'Not you?' forgets it", () => {
    const s = memory();
    expect(readRememberedAccount(s)).toBeNull();
    rememberAccount("  ada@example.com ", 1_700_000_000_000, s);
    expect(readRememberedAccount(s)).toEqual({ email: "ada@example.com", at: 1_700_000_000_000 });
    forgetAccount(s);
    expect(readRememberedAccount(s)).toBeNull();
  });

  it("falls back to nothing when storage is blocked", () => {
    expect(() => rememberAccount("ada@example.com", 1, blocked)).not.toThrow();
    expect(readRememberedAccount(blocked)).toBeNull();
    expect(() => forgetAccount(blocked)).not.toThrow();
    expect(readRememberedAccount(null)).toBeNull();
  });

  it("falls back to nothing without a window (server render)", () => {
    expect(readRememberedAccount()).toBeNull();
    expect(() => rememberAccount("ada@example.com")).not.toThrow();
  });

  it.each(["{nope", "null", "[]", '{"email":"ada"}', '{"email":"a@b.co"}', '{"email":"a@b.co","at":"x"}', '{"email":1,"at":1}'])(
    "ignores a malformed value %s",
    (raw) => {
      const s = memory();
      s.m.set(REMEMBERED_ACCOUNT_KEY, raw);
      expect(readRememberedAccount(s)).toBeNull();
    },
  );

  it("ignores a blank email", () => {
    const s = memory();
    rememberAccount("   ", 1, s);
    expect(s.m.size).toBe(0);
  });
});

describe("relativeDay", () => {
  const now = new Date(2026, 10, 4, 10, 0).getTime();
  const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo, d, h).getTime();

  it.each([
    [at(2026, 10, 4, 1), "today"],
    [at(2026, 10, 4, 23), "today"],
    [at(2026, 10, 3, 23), "yesterday"],
    [at(2026, 10, 1), "3 days ago"],
    [at(2026, 9, 22), "13 days ago"],
    [at(2026, 9, 21), "2 weeks ago"],
    [at(2026, 8, 20), "6 weeks ago"],
    [at(2026, 8, 1), "2 months ago"],
    [at(2026, 4, 4), "6 months ago"],
    [at(2025, 10, 4), "1 year ago"],
    [at(2023, 10, 1), "3 years ago"],
  ])("%s → %s", (t, want) => {
    expect(relativeDay(t, now)).toBe(want);
  });
});

describe("emailInitials", () => {
  it.each([
    ["amit.mehta@motadata.com", "AM"],
    ["neel@example.com", "NE"],
    ["a@example.com", "A"],
    ["j_doe+x@example.com", "JD"],
  ])("%s → %s", (email, want) => {
    expect(emailInitials(email)).toBe(want);
  });
});
