import { describe, expect, it } from "vitest";
import {
  accessSummary,
  addedBy,
  defaultAccessText,
  filterMembers,
  isRestrictedAndEmpty,
  lastActive,
  matchLine,
  parseMemberFilters,
  roleCounts,
  sourceLines,
  sourceText,
} from "./access-members";
import type { AccessMember, AccessSource, ProjectRole } from "./identity";

const person = (name: string, email: string, role: ProjectRole, sources: AccessSource[], direct: ProjectRole | null = null): AccessMember => ({
  user_id: email,
  name,
  email,
  avatar_initials: name.slice(0, 2).toUpperCase(),
  effective_role: role,
  sources,
  direct_role: direct,
  added_at: "2026-11-01T10:00:00Z",
  added_by: direct ? { id: "a", name: "Ada Admin" } : undefined,
  last_active_at: null,
});

const olive = person("Olive Owner", "olive@example.com", "admin", [{ kind: "org_role", role: "admin", org_role: "owner" }]);
const max = person("Max Member", "max@example.com", "editor", [{ kind: "default", role: "editor", org_role: "member" }]);
const tom = person("Tom Becker", "tom@example.com", "editor", [{ kind: "default", role: "viewer", org_role: "viewer" }, { kind: "direct", role: "editor" }], "editor");
const lena = person("Lena Kovač", "lena@example.com", "viewer", [{ kind: "direct", role: "viewer" }], "viewer");
const all = [olive, max, tom, lena];

describe("parseMemberFilters", () => {
  it("reads known roles and sources and ignores the rest", () => {
    expect(parseMemberFilters({ role: "editor", source: "direct" })).toEqual({ role: "editor", source: "direct" });
    expect(parseMemberFilters(new URLSearchParams("role=owner&source=team"))).toEqual({ role: null, source: null });
    expect(parseMemberFilters({})).toEqual({ role: null, source: null });
  });
});

describe("filterMembers", () => {
  it("searches name and email, accents and case ignored", () => {
    expect(filterMembers(all, "kovac", { role: null, source: null })).toEqual([lena]);
    expect(filterMembers(all, "MAX@", { role: null, source: null })).toEqual([max]);
  });
  it("filters by effective role and by any source of a kind", () => {
    expect(filterMembers(all, "", { role: "editor", source: null })).toEqual([max, tom]);
    expect(filterMembers(all, "", { role: null, source: "direct" })).toEqual([tom, lena]);
    expect(filterMembers(all, "", { role: "editor", source: "direct" })).toEqual([tom]);
  });
});

describe("source copy", () => {
  it("names each source in domain words", () => {
    expect(sourceText({ kind: "org_role", role: "admin", org_role: "owner" })).toBe("Organization owner");
    expect(sourceText({ kind: "default", role: "editor", org_role: "member" })).toBe("Organization member (project default)");
    expect(sourceText({ kind: "direct", role: "viewer" })).toBe("Added to this project");
  });
  it("gives one line per source, with the role only when there are two", () => {
    expect(sourceLines(max)).toEqual([{ kind: "default", text: "Organization member (project default)" }]);
    expect(sourceLines(tom)).toEqual([
      { kind: "default", text: "Organization viewer (project default)", role: "Viewer" },
      { kind: "direct", text: "Added to this project", role: "Editor" },
    ]);
  });
});

describe("summary", () => {
  it("counts people per effective role", () => {
    expect(roleCounts(all)).toEqual({ admin: 1, editor: 2, viewer: 1 });
    expect(accessSummary(all)).toBe("4 people have access: 1 Admin, 2 Editors, 1 Viewer.");
    expect(accessSummary([olive])).toBe("1 person has access: 1 Admin.");
  });
  it("says the default access in words", () => {
    expect(defaultAccessText("org_role")).toBe("Default access: organization members can edit and organization viewers can view.");
    expect(defaultAccessText("none")).toBe("Default access: only organization owners and admins, and people added directly.");
  });
  it("knows a restricted project nobody was added to", () => {
    expect(isRestrictedAndEmpty("none", [olive])).toBe(true);
    expect(isRestrictedAndEmpty("none", [olive, lena])).toBe(false);
    expect(isRestrictedAndEmpty("org_role", [olive])).toBe(false);
  });
  it("counts matches only while searching or filtering", () => {
    expect(matchLine(4, 4, "", { role: null, source: null })).toBe("");
    expect(matchLine(2, 9, "", { role: "editor", source: null })).toBe("2 of 9 people match");
  });
});

describe("cells", () => {
  it("shows last activity and who added someone", () => {
    expect(lastActive(null)).toBe("Never signed in");
    expect(lastActive("2026-11-12T10:00:00Z", Date.parse("2026-11-13T10:00:00Z"))).toBe("Yesterday");
    expect(addedBy(tom)).toBe("Ada Admin");
    expect(addedBy(max)).toBe("—");
  });
});
