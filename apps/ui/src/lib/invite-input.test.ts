import { describe, expect, it } from "vitest";
import { MAX_INVITES, addInviteChips, inviteChipsError, inviteEntries, isEmail, sendInvitesLabel, splitInviteText } from "./invite-input";

describe("splitInviteText", () => {
  it("splits on commas, semicolons, spaces and new lines and strips brackets", () => {
    expect(splitInviteText("Ada@Example.com, grace@example.com\n<ada@example.com>; bad  nope@")).toEqual([
      "Ada@Example.com",
      "grace@example.com",
      "ada@example.com",
      "bad",
      "nope@",
    ]);
    expect(splitInviteText("  ")).toEqual([]);
  });
});

describe("addInviteChips", () => {
  it("lower-cases addresses, drops duplicates and keeps invalid entries as typed", () => {
    const chips = addInviteChips([], "Ada@Example.com, grace@example.com <ada@example.com> Bad nope@", "member");
    expect(chips).toEqual([
      { email: "ada@example.com", role: "member", valid: true },
      { email: "grace@example.com", role: "member", valid: true },
      { email: "Bad", role: "member", valid: false },
      { email: "nope@", role: "member", valid: false },
    ]);
  });

  it("appends with the role given and never changes existing chips", () => {
    const first = addInviteChips([], "ada@example.com", "admin");
    const next = addInviteChips(first, "ADA@example.com grace@example.com", "viewer");
    expect(next).toEqual([
      { email: "ada@example.com", role: "admin", valid: true },
      { email: "grace@example.com", role: "viewer", valid: true },
    ]);
    expect(first).toHaveLength(1);
  });

  it("adds nothing for blank text", () => {
    expect(addInviteChips([], " , ", "member")).toEqual([]);
  });
});

describe("inviteChipsError", () => {
  it("names the first invalid chip", () => {
    const chips = addInviteChips([], "ada@example.com not-an-address", "member");
    expect(inviteChipsError(chips)).toBe("“not-an-address” isn’t an email address. Remove it or fix it.");
  });

  it("needs at least one and at most MAX_INVITES addresses", () => {
    expect(inviteChipsError([])).toBe("Enter at least one email address.");
    const many = addInviteChips([], Array.from({ length: MAX_INVITES + 1 }, (_, i) => `p${i}@example.com`).join(" "), "member");
    expect(inviteChipsError(many)).toBe(`Invite at most ${MAX_INVITES} people at a time.`);
    expect(inviteChipsError(many.slice(0, MAX_INVITES))).toBeNull();
  });
});

describe("inviteEntries", () => {
  it("sends valid chips with their own role", () => {
    const chips = addInviteChips(addInviteChips([], "ada@example.com", "admin"), "grace@example.com nope", "viewer");
    expect(inviteEntries(chips)).toEqual([
      { email: "ada@example.com", role: "admin" },
      { email: "grace@example.com", role: "viewer" },
    ]);
  });
});

describe("helpers", () => {
  it("checks addresses", () => {
    expect(isEmail("ada@example.com")).toBe(true);
    expect(isEmail("ada@example")).toBe(false);
    expect(isEmail(`${"a".repeat(320)}@example.com`)).toBe(false);
  });

  it("labels the send button", () => {
    expect(sendInvitesLabel(0)).toBe("Send invitation");
    expect(sendInvitesLabel(1)).toBe("Send invitation");
    expect(sendInvitesLabel(3)).toBe("Send 3 invitations");
  });
});
