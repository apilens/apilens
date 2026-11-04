import { describe, expect, it } from "vitest";
import {
  MAX_ALLOWED_DOMAINS,
  addDomains,
  canDeleteOrg,
  canManageOrg,
  checkDomains,
  checkOrgName,
  deleteConfirmed,
  isValidDomain,
  normalizeDomain,
  orgSettingsError,
  splitDomains,
} from "./org-settings";

describe("roles", () => {
  it("lets owners and admins manage, only owners delete", () => {
    const roles = ["owner", "admin", "member", "viewer"] as const;
    expect(roles.map(canManageOrg)).toEqual([true, true, false, false]);
    expect(roles.map(canDeleteOrg)).toEqual([true, false, false, false]);
  });
});

describe("checkOrgName", () => {
  it("trims and accepts a name", () => {
    expect(checkOrgName("  Acme Inc  ")).toEqual({ ok: true, name: "Acme Inc" });
  });
  it("rejects a blank or too long name", () => {
    expect(checkOrgName("   ").ok).toBe(false);
    expect(checkOrgName("a".repeat(100)).ok).toBe(true);
    expect(checkOrgName("a".repeat(101)).ok).toBe(false);
  });
});

describe("domains", () => {
  it.each([
    ["Acme.COM", "acme.com"],
    ["  @acme.com ", "acme.com"],
    ["https://acme.com/team?x=1", "acme.com"],
    ["acme.com.", "acme.com"],
    ["*.acme.com", "acme.com"],
    ["someone@eu.acme.io", "eu.acme.io"],
  ])("normalizes %j to %j", (raw, want) => {
    expect(normalizeDomain(raw)).toBe(want);
  });

  it("accepts hostnames the API accepts and nothing else", () => {
    for (const ok of ["acme.com", "eu.acme.co.uk", "a-b.io", "x1.dev"]) expect(isValidDomain(ok), ok).toBe(true);
    for (const bad of ["acme", "acme.", "-acme.com", "acme-.com", "acme.123", "ac me.com", "Acme.com", "", `${"a".repeat(64)}.com`]) {
      expect(isValidDomain(bad), bad).toBe(false);
    }
  });

  it("splits pasted lists", () => {
    expect(splitDomains("acme.com, acme.io;acme.dev\n  b.com")).toEqual(["acme.com", "acme.io", "acme.dev", "b.com"]);
  });

  it("adds new domains once, in order", () => {
    expect(addDomains(["acme.com"], "ACME.com acme.io acme.io")).toEqual({ domains: ["acme.com", "acme.io"], error: null });
  });

  it("adds nothing when one entry is not a domain", () => {
    const res = addDomains(["acme.com"], "acme.io nope");
    expect(res.domains).toEqual(["acme.com"]);
    expect(res.error).toContain("nope");
  });

  it("caps the list", () => {
    const full = Array.from({ length: MAX_ALLOWED_DOMAINS }, (_, i) => `d${i}.com`);
    expect(addDomains(full, "one-more.com").error).toMatch(/at most 50/);
    expect(addDomains(full, "d1.com").error).toBeNull();
  });

  it("checks a list sent to a Server Action", () => {
    expect(checkDomains(["Acme.com", "acme.com", "acme.io"])).toEqual({ ok: true, domains: ["acme.com", "acme.io"] });
    expect(checkDomains([])).toEqual({ ok: true, domains: [] });
    expect(checkDomains("acme.com").ok).toBe(false);
    expect(checkDomains([1]).ok).toBe(false);
    expect(checkDomains(["acme"]).ok).toBe(false);
  });
});

describe("deleteConfirmed", () => {
  it("needs the exact slug", () => {
    expect(deleteConfirmed("acme", " acme ")).toBe(true);
    expect(deleteConfirmed("acme", "Acme")).toBe(false);
    expect(deleteConfirmed("acme", "")).toBe(false);
  });
});

describe("orgSettingsError", () => {
  it("explains the server's codes", () => {
    expect(orgSettingsError("domain_not_allowed")).toMatch(/Public email domains/);
    expect(orgSettingsError("forbidden")).toMatch(/permission/);
    expect(orgSettingsError("something_new")).toMatch(/Something went wrong/);
  });
});
