import { describe, expect, it } from "vitest";
import {
  accessChangeError,
  addCandidates,
  addedMessage,
  changeConsequence,
  changedMessage,
  isProjectRole,
  isProjectSlug,
  isUserId,
  listNames,
  removeConsequence,
  removedMessage,
} from "./access-changes";
import type { AccessMember, Member } from "./identity";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const member = (n: number, name: string, role: Member["role"]): Member => ({
  user: { id: ID(n), email: `${name.toLowerCase().split(" ")[0]}@example.com`, name, avatar_url: "" },
  role,
  joined_at: "2026-10-01T10:00:00Z",
  last_login_at: null,
});

describe("input checks", () => {
  it("accepts project slugs, UUIDs and the three roles only", () => {
    expect(isProjectSlug("shop")).toBe(true);
    expect(isProjectSlug("Shop")).toBe(false);
    expect(isProjectSlug("../x")).toBe(false);
    expect(isUserId(ID(1))).toBe(true);
    expect(isUserId("1; drop")).toBe(false);
    expect(isUserId(42)).toBe(false);
    expect(["admin", "editor", "viewer"].every(isProjectRole)).toBe(true);
    expect(isProjectRole("owner")).toBe(false);
    expect(isProjectRole(undefined)).toBe(false);
  });
});

describe("addCandidates", () => {
  it("offers org members without a direct role, never org owners or admins, by name", () => {
    const org = [member(1, "Olive Owner", "owner"), member(2, "Ada Admin", "admin"), member(3, "Vera Viewer", "viewer"), member(4, "Max Member", "member"), member(5, "Lena Kovač", "member")];
    const access = [
      { user_id: ID(4), direct_role: null },
      { user_id: ID(5), direct_role: "viewer" as const },
    ];
    expect(addCandidates(org, access).map((c) => c.name)).toEqual(["Max Member", "Vera Viewer"]);
    expect(addCandidates(org, access)[0]).toEqual({ user_id: ID(4), name: "Max Member", email: "max@example.com", initials: "MM" });
  });
});

const person = (sources: AccessMember["sources"]): Pick<AccessMember, "name" | "email" | "sources"> => ({ name: "Mina Ito", email: "mina@example.com", sources });

describe("what a change leaves the person with", () => {
  it("says the role they keep through the project default or the organization", () => {
    const viaDefault = person([
      { kind: "default", role: "editor", org_role: "member" },
      { kind: "direct", role: "viewer" },
    ]);
    expect(removeConsequence(viaDefault, "Shop")).toBe("Mina Ito stays an Editor through the project default.");
    const viaOrg = person([
      { kind: "org_role", role: "admin", org_role: "admin" },
      { kind: "direct", role: "editor" },
    ]);
    expect(removeConsequence(viaOrg, "Shop")).toBe("Mina Ito stays an Admin through the organization.");
  });

  it("says they lose access when nothing else gives them a role", () => {
    expect(removeConsequence(person([{ kind: "direct", role: "admin" }]), "Shop")).toBe("Mina Ito loses access to Shop.");
    expect(removeConsequence(person(null), "Shop")).toBe("Mina Ito loses access to Shop.");
  });

  it("warns only when a lower direct role is outranked by another source", () => {
    const p = person([{ kind: "default", role: "editor", org_role: "member" }]);
    expect(changeConsequence(p, "viewer")).toBe("Mina Ito stays an Editor through the project default.");
    expect(changeConsequence(p, "editor")).toBeNull();
    expect(changeConsequence(p, "admin")).toBeNull();
    expect(changeConsequence(person([{ kind: "direct", role: "editor" }]), "viewer")).toBeNull();
  });
});

describe("status line sentences", () => {
  it("names who was added and the role", () => {
    expect(listNames(["Max"])).toBe("Max");
    expect(listNames(["Max", "Vera", "Sam"])).toBe("Max, Vera and Sam");
    expect(addedMessage(["Max Member", "Vera Viewer"], "admin", "Shop")).toBe("Added Max Member and Vera Viewer to Shop as Admins.");
    expect(addedMessage(["Max Member"], "viewer", "Shop")).toBe("Added Max Member to Shop as Viewer.");
  });

  it("says the new role and what a removal leaves", () => {
    expect(changedMessage("Tom Becker", "admin", "Shop")).toBe("Tom Becker is now an Admin on Shop.");
    expect(removedMessage(person([{ kind: "default", role: "viewer", org_role: "viewer" }, { kind: "direct", role: "admin" }]), "Shop")).toBe(
      "Removed Mina Ito from Shop. Mina Ito stays a Viewer through the project default.",
    );
  });

  it("answers a sentence for every API code", () => {
    expect(accessChangeError("forbidden")).toBe("Only project admins can change access.");
    expect(accessChangeError("not_org_member")).toMatch(/no longer in the organization/);
    expect(accessChangeError("weird")).toBe("Couldn’t change access right now. Try again.");
    expect(accessChangeError(undefined)).toBe("Couldn’t change access right now. Try again.");
  });
});
