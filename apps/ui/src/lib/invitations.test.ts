import { describe, expect, it } from "vitest";
import { RESEND_COOLDOWN_MS, formatDay, formatWait, invitationsError, inviterName, isExpired, lastSentAt, resendWait } from "./invitations";

const created = "2026-11-04T10:00:00Z";
const at = (iso: string) => Date.parse(iso);

describe("resend cooldown", () => {
  it("counts from the last email: resent_at, else created_at", () => {
    expect(lastSentAt({ created_at: created, resent_at: null })).toBe(at(created));
    expect(lastSentAt({ created_at: created, resent_at: "2026-11-04T11:00:00Z" })).toBe(at("2026-11-04T11:00:00Z"));
  });

  it("waits five minutes after the last email", () => {
    const inv = { created_at: created, resent_at: null };
    expect(resendWait(inv, at(created))).toBe(RESEND_COOLDOWN_MS);
    expect(resendWait(inv, at("2026-11-04T10:03:00Z"))).toBe(2 * 60_000);
    expect(resendWait(inv, at("2026-11-04T10:05:00Z"))).toBe(0);
    expect(resendWait(inv, at("2026-11-05T10:00:00Z"))).toBe(0);
    expect(resendWait({ created_at: "garbage", resent_at: null }, 0)).toBe(0);
  });

  it("formats a wait as m:ss, rounding up", () => {
    expect(formatWait(RESEND_COOLDOWN_MS)).toBe("5:00");
    expect(formatWait(245_001)).toBe("4:06");
    expect(formatWait(9_000)).toBe("0:09");
    expect(formatWait(-1)).toBe("0:00");
  });
});

describe("display", () => {
  it("knows when the link expired", () => {
    const inv = { expires_at: "2026-11-11T10:00:00Z" };
    expect(isExpired(inv, at("2026-11-11T09:59:59Z"))).toBe(false);
    expect(isExpired(inv, at("2026-11-11T10:00:00Z"))).toBe(true);
    expect(isExpired({ expires_at: "" }, 0)).toBe(false);
  });

  it("formats days in UTC", () => {
    expect(formatDay("2026-11-11T23:30:00Z")).toBe("Nov 11, 2026");
    expect(formatDay("nope")).toBe("Unknown");
  });

  it("names the inviter", () => {
    expect(inviterName({ invited_by: { id: "u", email: "ada@example.com", name: "Ada Admin" } })).toBe("Ada Admin");
    expect(inviterName({ invited_by: { id: "u", email: "ada@example.com", name: " " } })).toBe("ada@example.com");
    expect(inviterName({})).toBe("—");
  });
});

describe("invitationsError", () => {
  it("has a sentence for every documented code", () => {
    for (const code of ["invite_expired", "rate_limited", "forbidden", "not_found", "invalid_request", "network_error"]) {
      expect(invitationsError(code)).not.toBe(invitationsError("something_new"));
    }
  });
});
