import { describe, expect, it } from "vitest";
import {
  MAX_NAME,
  checkName,
  checkNewEmail,
  cleanCode,
  deleteConfirmed,
  isCode,
  ownedOrgs,
  profileError,
} from "./profile";

describe("checkName", () => {
  it("trims and accepts a name", () => {
    expect(checkName("  Ada Lovelace ")).toEqual({ ok: true, name: "Ada Lovelace" });
  });

  it("refuses an empty or too long name", () => {
    expect(checkName("   ")).toMatchObject({ ok: false });
    expect(checkName("a".repeat(MAX_NAME))).toMatchObject({ ok: true });
    expect(checkName("a".repeat(MAX_NAME + 1))).toMatchObject({ ok: false, error: expect.stringContaining("120") });
  });
});

describe("checkNewEmail", () => {
  it("accepts a different address", () => {
    expect(checkNewEmail(" new@example.com ", "you@example.com")).toEqual({ ok: true, email: "new@example.com" });
  });

  it("refuses the current address, in any case", () => {
    expect(checkNewEmail("YOU@example.com", "you@example.com")).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
  });

  it("refuses something that is not an address", () => {
    expect(checkNewEmail("", "you@example.com")).toMatchObject({ ok: false });
    expect(checkNewEmail("not an email", "you@example.com")).toMatchObject({ ok: false });
    expect(checkNewEmail("a@b", "you@example.com")).toMatchObject({ ok: false });
  });
});

describe("codes", () => {
  it("ignores spaces and hyphens", () => {
    expect(cleanCode("123 456")).toBe("123456");
    expect(cleanCode("123-456")).toBe("123456");
    expect(isCode(" 123-456 ")).toBe(true);
  });

  it("needs exactly six digits", () => {
    expect(isCode("12345")).toBe(false);
    expect(isCode("1234567")).toBe(false);
    expect(isCode("12a456")).toBe(false);
  });
});

describe("deleteConfirmed", () => {
  it("matches the email ignoring case and surrounding spaces", () => {
    expect(deleteConfirmed("you@example.com", " YOU@example.com ")).toBe(true);
    expect(deleteConfirmed("you@example.com", "you@example.co")).toBe(false);
    expect(deleteConfirmed("", "")).toBe(false);
  });
});

describe("ownedOrgs", () => {
  it("keeps the organizations the user owns, linked to their settings", () => {
    expect(
      ownedOrgs([
        { slug: "acme", name: "Acme", role: "owner" },
        { slug: "beta", name: "Beta", role: "admin" },
      ]),
    ).toEqual([{ slug: "acme", name: "Acme", href: "/orgs/acme/settings" }]);
  });
});

describe("profileError", () => {
  it("has a sentence for each code the endpoints answer", () => {
    for (const code of ["email_taken", "invalid_code", "code_expired", "too_many_attempts", "owner_transfer_required", "invalid_request"]) {
      expect(profileError(code)).not.toBe(profileError("something_else"));
      expect(profileError(code)).toMatch(/\.$/);
    }
  });
});
