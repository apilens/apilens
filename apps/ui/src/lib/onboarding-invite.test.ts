import { describe, expect, it } from "vitest";
import type { InviteResult } from "./identity";
import { TOGGLE_ROLES, canInvite, inviteError, inviteOutcomes, outcomeTitle, sentCount } from "./onboarding-invite";

const results: InviteResult[] = [
  { email: "ada@example.com", status: "invited" },
  { email: "grace@example.com", status: "replaced" },
  { email: "you@example.com", status: "already_member" },
  { email: "ada@example.com", status: "duplicate" },
];

describe("inviteOutcomes", () => {
  it("reads one line per address, in request order", () => {
    expect(inviteOutcomes(results)).toEqual([
      { email: "ada@example.com", label: "Invitation sent", tone: "ok" },
      { email: "grace@example.com", label: "New invitation sent", tone: "ok" },
      { email: "you@example.com", label: "Already a member", tone: "muted" },
      { email: "ada@example.com", label: "Listed twice, sent once", tone: "muted" },
    ]);
  });

  it("does not claim an unknown status was sent", () => {
    expect(inviteOutcomes([{ email: "x@example.com", status: "later" as InviteResult["status"] }])[0]).toMatchObject({ label: "Not sent", tone: "muted" });
  });
});

describe("sentCount and outcomeTitle", () => {
  it("counts invited and replaced", () => {
    expect(sentCount(results)).toBe(2);
    expect(outcomeTitle(results)).toBe("2 invitations sent");
    expect(outcomeTitle(results.slice(0, 1))).toBe("1 invitation sent");
    expect(outcomeTitle(results.slice(2))).toBe("No invitations were sent");
  });
});

describe("canInvite", () => {
  it("allows owners and admins only", () => {
    expect(canInvite("owner")).toBe(true);
    expect(canInvite("admin")).toBe(true);
    expect(canInvite("member")).toBe(false);
    expect(canInvite("viewer")).toBe(false);
  });
});

describe("TOGGLE_ROLES", () => {
  it("toggles member and viewer, member first", () => {
    expect(TOGGLE_ROLES).toEqual(["member", "viewer"]);
  });
});

describe("inviteError", () => {
  it("answers a sentence per code", () => {
    expect(inviteError("forbidden")).toContain("owners and admins");
    expect(inviteError("validation_failed")).toContain("addresses weren’t accepted");
    expect(inviteError("unavailable")).toContain("couldn’t reach");
    expect(inviteError("rate_limited")).toContain("Wait a moment");
    expect(inviteError("weird")).toContain("couldn’t send");
  });
});
