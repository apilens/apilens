import { describe, expect, it } from "vitest";
import type { AccessMember, AccessSource, ProjectRole } from "./identity";
import {
  PROJECT_ROLES,
  compareRoles,
  effectiveSource,
  highestRole,
  isOrgAdmin,
  memberChange,
  roleRank,
  roleWithoutDirect,
  sourceLabel,
} from "./project-access";

const member = (sources: AccessSource[], direct: ProjectRole | null = null): AccessMember => ({
  user_id: "3f0e8c1a-2b4d-4e6f-8a1b-2c3d4e5f6a7b",
  name: "Max Member",
  email: "max@example.com",
  avatar_initials: "MM",
  effective_role: highestRole(sources.map((s) => s.role)) ?? "viewer",
  sources,
  direct_role: direct,
  added_at: "2026-10-01T10:00:00Z",
  last_active_at: null,
});

describe("role order", () => {
  it("ranks viewer < editor < admin and nothing else", () => {
    expect(PROJECT_ROLES.map(roleRank)).toEqual([3, 2, 1]);
    expect(roleRank("owner")).toBe(0);
    expect(roleRank(null)).toBe(0);
    expect(roleRank("toString")).toBe(0);
  });

  it("sorts highest first and picks the highest", () => {
    expect((["viewer", "admin", "editor"] as ProjectRole[]).sort(compareRoles)).toEqual(["admin", "editor", "viewer"]);
    expect(highestRole(["viewer", null, "editor"])).toBe("editor");
    expect(highestRole([])).toBeNull();
  });
});

describe("sourceLabel", () => {
  it.each<[AccessSource, string]>([
    [{ kind: "org_role", role: "admin", org_role: "owner" }, "Organization owner"],
    [{ kind: "org_role", role: "admin", org_role: "admin" }, "Organization admin"],
    [{ kind: "org_role", role: "admin" }, "Organization role"],
    [{ kind: "default", role: "editor", org_role: "member" }, "Project default"],
    [{ kind: "direct", role: "viewer" }, "Added directly"],
  ])("labels %j as %s", (source, label) => {
    expect(sourceLabel(source)).toBe(label);
  });
});

describe("effectiveSource", () => {
  it("is the source granting the effective role, organization before direct before default", () => {
    const def: AccessSource = { kind: "default", role: "editor", org_role: "member" };
    const direct: AccessSource = { kind: "direct", role: "editor" };
    expect(effectiveSource(member([def, direct], "editor"))).toBe(direct);
    expect(effectiveSource(member([def, { kind: "direct", role: "viewer" }], "viewer"))).toBe(def);
    const org: AccessSource = { kind: "org_role", role: "admin", org_role: "owner" };
    expect(effectiveSource(member([org, { kind: "direct", role: "admin" }], "admin"))).toBe(org);
    expect(effectiveSource({ effective_role: "viewer", sources: null })).toBeNull();
  });
});

describe("who can be changed", () => {
  const owner = member([{ kind: "org_role", role: "admin", org_role: "owner" }]);
  const byDefault = member([{ kind: "default", role: "editor", org_role: "member" }]);
  const granted = member([{ kind: "default", role: "viewer", org_role: "viewer" }, { kind: "direct", role: "editor" }], "editor");

  it("nobody without access.manage", () => {
    for (const m of [owner, byDefault, granted]) {
      expect(memberChange(m, false)).toEqual({ changeRole: false, remove: false, reason: "Only project admins can change access." });
    }
  });

  it("org owners and admins stay Admin", () => {
    expect(isOrgAdmin(owner)).toBe(true);
    expect(memberChange(owner, true)).toMatchObject({ changeRole: false, remove: false });
    expect(memberChange(owner, true).reason).toMatch(/Admin on every project/);
  });

  it("anyone else can get a direct role; only a direct grant can be removed", () => {
    expect(memberChange(byDefault, true)).toEqual({ changeRole: true, remove: false });
    expect(memberChange(granted, true)).toEqual({ changeRole: true, remove: true });
  });

  it("knows what is left once a direct grant goes", () => {
    expect(roleWithoutDirect(granted)).toBe("viewer");
    expect(roleWithoutDirect(member([{ kind: "direct", role: "admin" }], "admin"))).toBeNull();
    expect(roleWithoutDirect(owner)).toBe("admin");
  });
});
