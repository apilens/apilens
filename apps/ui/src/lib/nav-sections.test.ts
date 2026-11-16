import { describe, expect, it } from "vitest";
import { VIEWS } from "./data";
import { navGroups, viewLabel } from "./nav-sections";

describe("navGroups", () => {
  it("puts every page under Monitor, Catalog or Configure, in that order", () => {
    expect(navGroups().map((g) => [g.section, g.views.map((v) => v.label)])).toEqual([
      ["Monitor", ["Incidents", "Explore", "Traffic", "Errors", "Performance", "Consumers"]],
      ["Catalog", ["Apps", "Changes"]],
      ["Configure", ["Access"]],
    ]);
  });

  it("lists each view exactly once", () => {
    expect(navGroups().flatMap((g) => g.views)).toHaveLength(VIEWS.length);
  });
});

describe("viewLabel", () => {
  const project = { orgScope: false, account: false };
  it("is the nav label of a project page", () => {
    expect(viewLabel("traffic", project)).toBe("Traffic");
    expect(viewLabel("settings", project)).toBe("Project settings");
  });

  it("names the org and account settings scopes", () => {
    expect(viewLabel("settings", { orgScope: true, account: false })).toBe("Organization settings");
    expect(viewLabel("settings", { orgScope: true, account: true })).toBe("Account settings");
  });

  it("is empty for an unknown page", () => {
    expect(viewLabel("nope", project)).toBe("");
  });
});
