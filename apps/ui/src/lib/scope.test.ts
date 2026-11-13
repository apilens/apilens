import { describe, expect, it } from "vitest";
import type { UserContext } from "./identity";
import { findOrg, findProject, orgHome, orgMark, plural, roleLabel, userLabel } from "./scope";

const CTX = {
  orgs: [
    {
      id: "o1",
      slug: "acme",
      name: "Acme Retail",
      role: "owner",
      projects: [
        { id: "p1", slug: "shop", name: "shop", environments: ["production", "staging"], app_count: 1 },
        { id: "p2", slug: "billing", name: "billing", environments: ["production"], app_count: 1 },
      ],
    },
    { id: "o2", slug: "labs", name: "labs", role: "viewer", projects: [] },
  ],
} as unknown as UserContext;

describe("findProject / findOrg", () => {
  it("resolves a project and its organization", () => {
    const found = findProject(CTX, "billing");
    expect(found?.org.slug).toBe("acme");
    expect(found?.project.id).toBe("p2");
  });

  it("is undefined for a project or org the user cannot see", () => {
    expect(findProject(CTX, "platform")).toBeUndefined();
    expect(findOrg(CTX, "northwind")).toBeUndefined();
    expect(findOrg(CTX, "labs")?.role).toBe("viewer");
  });
});

describe("orgHome", () => {
  it("opens the first project, or org settings when there is none", () => {
    expect(orgHome(CTX.orgs[0], "incidents")).toBe("/shop/incidents");
    expect(orgHome(CTX.orgs[1], "incidents")).toBe("/orgs/labs/settings");
  });
});

describe("labels", () => {
  it("formats marks, roles and counts", () => {
    expect(orgMark(CTX.orgs[1])).toBe("L");
    expect(roleLabel("admin")).toBe("Admin");
    expect(plural(1, "project")).toBe("1 project");
    expect(plural(0, "project")).toBe("0 projects");
  });

  it("shows the user's name, else the email's local part", () => {
    expect(userLabel({ name: "Grace Hopper", email: "grace@example.com" })).toEqual({ name: "Grace Hopper", initials: "GH", email: "grace@example.com" });
    expect(userLabel({ name: null, email: "you@example.com" })).toEqual({ name: "you", initials: "YO", email: "you@example.com" });
    expect(userLabel({ name: "  ", email: "ada.lovelace@example.com" }).initials).toBe("AL");
  });
});
