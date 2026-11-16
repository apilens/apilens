import { describe, expect, it } from "vitest";
import { PROJECT_SECTIONS, projectSection, projectSectionHref, projectSectionTitle, visibleProjectSections } from "./project-settings";

describe("PROJECT_SECTIONS", () => {
  it("lists the sections in order and grouped", () => {
    expect(PROJECT_SECTIONS.map((s) => `${s.group}: ${s.label}`)).toEqual([
      "Project: General",
      "Project: Environments",
      "Project: SDK setup",
      "Data: Capture",
      "Data: Privacy",
      "Data: Retention",
      "Data: Ingest health",
      "Data: Usage",
      "Alerting: Alert channels",
      "Alerting: Health checks",
      "More: Integrations",
      "More: Danger zone",
    ]);
  });

  it("has unique slugs and no API keys (they move to Access)", () => {
    const slugs = PROJECT_SECTIONS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).not.toContain("keys");
  });

  it("flags only the danger zone", () => {
    expect(PROJECT_SECTIONS.filter((s) => s.danger).map((s) => s.slug)).toEqual(["danger"]);
  });
});

describe("projectSection", () => {
  it("opens General at /settings", () => {
    expect(projectSection(undefined)?.label).toBe("General");
    expect(projectSection([])?.label).toBe("General");
  });

  it("resolves sections by slug", () => {
    expect(projectSection(["ingest"])?.label).toBe("Ingest health");
    expect(projectSection(["alerts"])?.label).toBe("Alert channels");
    expect(projectSection(["health-checks"])?.label).toBe("Health checks");
  });

  it("is undefined (404) for unknown or nested sections", () => {
    expect(projectSection(["keys"])).toBeUndefined();
    expect(projectSection(["general"])).toBeUndefined();
    expect(projectSection([""])).toBeUndefined();
    expect(projectSection(["capture", "x"])).toBeUndefined();
  });
});

describe("projectSectionHref", () => {
  it("links under /<project>/settings and round-trips", () => {
    expect(projectSectionHref("shop", PROJECT_SECTIONS[0])).toBe("/shop/settings");
    expect(projectSectionHref("shop", { slug: "privacy" })).toBe("/shop/settings/privacy");
    for (const s of PROJECT_SECTIONS) {
      const rest = projectSectionHref("shop", s).split("/").slice(3);
      expect(projectSection(rest)).toBe(s);
    }
  });
});

describe("visibleProjectSections", () => {
  it("hides the danger zone without project.delete", () => {
    const shown = visibleProjectSections({ shop: ["project.read"] }, "shop").map((s) => s.slug);
    expect(shown).not.toContain("danger");
    expect(shown).toHaveLength(PROJECT_SECTIONS.length - 1);
  });

  it("shows it with project.delete, or when it is the current section", () => {
    expect(visibleProjectSections({ shop: ["project.delete"] }, "shop").map((s) => s.slug)).toContain("danger");
    expect(visibleProjectSections({}, "shop", "danger").map((s) => s.slug)).toContain("danger");
  });
});

describe("projectSectionTitle", () => {
  it("is <Section> · Project settings", () => {
    expect(projectSectionTitle({ label: "Privacy" })).toBe("Privacy · Project settings");
  });
});
