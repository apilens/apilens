import { describe, expect, it } from "vitest";
import {
  accessImpact,
  choiceTitle,
  defaultAccessError,
  defaultRoleFor,
  dropLine,
  isDefaultAccess,
  isNarrower,
  loseLine,
  namesLine,
} from "./default-access";
import type { AccessMember, AccessSource, ProjectRole } from "./identity";

function member(name: string, effective: ProjectRole, sources: AccessSource[]): AccessMember {
  return {
    user_id: name,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
    avatar_initials: name.slice(0, 2).toUpperCase(),
    effective_role: effective,
    sources,
    direct_role: sources.find((s) => s.kind === "direct")?.role ?? null,
    added_at: "2026-10-01T10:00:00Z",
    last_active_at: null,
  };
}

// The fake's measured shop under the org_role default.
const PEOPLE = [
  member("Olive Owner", "admin", [{ kind: "org_role", role: "admin", org_role: "owner" }]),
  member("Max Member", "editor", [{ kind: "default", role: "editor", org_role: "member" }]),
  member("Vera Viewer", "viewer", [{ kind: "default", role: "viewer", org_role: "viewer" }]),
  member("Priya Patel", "admin", [
    { kind: "default", role: "editor", org_role: "member" },
    { kind: "direct", role: "admin" },
  ]),
  member("Tom Becker", "editor", [
    { kind: "default", role: "viewer", org_role: "viewer" },
    { kind: "direct", role: "editor" },
  ]),
  member("Lena Kovac", "editor", [
    { kind: "default", role: "editor", org_role: "member" },
    { kind: "direct", role: "viewer" },
  ]),
];

describe("isNarrower", () => {
  it("orders org_role > viewer > none", () => {
    expect(isNarrower("org_role", "viewer")).toBe(true);
    expect(isNarrower("org_role", "none")).toBe(true);
    expect(isNarrower("viewer", "none")).toBe(true);
    expect(isNarrower("none", "viewer")).toBe(false);
    expect(isNarrower("viewer", "org_role")).toBe(false);
    expect(isNarrower("none", "none")).toBe(false);
  });
});

describe("defaultRoleFor", () => {
  it("gives members and viewers a role, never owners or admins", () => {
    expect(defaultRoleFor("member", "org_role")).toBe("editor");
    expect(defaultRoleFor("viewer", "org_role")).toBe("viewer");
    expect(defaultRoleFor("member", "viewer")).toBe("viewer");
    expect(defaultRoleFor("member", "none")).toBeNull();
    expect(defaultRoleFor("owner", "org_role")).toBeNull();
    expect(defaultRoleFor(undefined, "viewer")).toBeNull();
  });
});

describe("accessImpact", () => {
  it("restricting removes everyone who only had the default", () => {
    const { lose, drop } = accessImpact(PEOPLE, "none");
    expect(lose.map((a) => a.member.name)).toEqual(["Max Member", "Vera Viewer"]);
    // Lena keeps her direct Viewer grant but drops from Editor.
    expect(drop.map((a) => [a.member.name, a.role])).toEqual([["Lena Kovac", "viewer"]]);
  });

  it("view only drops editors by default to Viewer and takes nobody's access", () => {
    const { lose, drop } = accessImpact(PEOPLE, "viewer");
    expect(lose).toEqual([]);
    expect(drop.map((a) => [a.member.name, a.role])).toEqual([
      ["Max Member", "viewer"],
      ["Lena Kovac", "viewer"],
    ]);
  });

  it("widening affects nobody", () => {
    expect(accessImpact(PEOPLE, "org_role")).toEqual({ lose: [], drop: [] });
  });
});

describe("namesLine", () => {
  const six = ["A", "B", "C", "D", "E", "F"].map((n) => ({ name: n, email: `${n}@example.com` }));
  it("names up to five, then how many more", () => {
    expect(namesLine(six)).toBe("A, B, C, D, E and 1 more");
    expect(namesLine(six.slice(0, 3))).toBe("A, B and C");
    expect(namesLine(six.slice(0, 1))).toBe("A");
    expect(namesLine([])).toBe("");
  });
  it("counts the rest from the dry run's total", () => {
    expect(namesLine(six.slice(0, 2), 9)).toBe("A, B and 7 more");
    expect(namesLine(six, 3)).toBe("A, B and C");
  });
  it("falls back to the email", () => {
    expect(namesLine([{ name: "", email: "x@example.com" }])).toBe("x@example.com");
  });
});

describe("copy", () => {
  it("names the organization and counts people", () => {
    expect(choiceTitle("viewer", "Acme")).toBe("Everyone in Acme can view");
    expect(choiceTitle("none", "Acme")).toBe("Restricted: only people added here and organization admins");
    expect(loseLine(1, "Shop")).toBe("1 person loses access to Shop");
    expect(loseLine(3, "Shop")).toBe("3 people lose access to Shop");
    const drop = accessImpact(PEOPLE, "viewer").drop;
    expect(dropLine(drop)).toBe("2 people drop to Viewer");
    expect(dropLine(drop.slice(0, 1))).toBe("1 person drops to Viewer");
  });
  it("answers a sentence for API errors", () => {
    expect(defaultAccessError("forbidden")).toBe("Only project admins can change the default access.");
    expect(defaultAccessError("something_else")).toBe("Couldn’t change the default access. Try again.");
  });
  it("knows the three defaults", () => {
    expect(isDefaultAccess("none")).toBe(true);
    expect(isDefaultAccess("admin")).toBe(false);
    expect(isDefaultAccess(undefined)).toBe(false);
  });
});
