import { describe, expect, it } from "vitest";
import { accessMenu, accountMenu, activeHref, incidentsMenu, orgSettingsMenu, projectSettingsMenu } from "./section-menus";

const shown = (spec: { groups: { title?: string; items: { label: string; hidden?: boolean }[] }[] }) =>
  spec.groups.map((g) => ({ title: g.title, items: g.items.filter((i) => !i.hidden).map((i) => i.label) }));

describe("activeHref", () => {
  const items = [{ href: "/project/shop/settings" }, { href: "/project/shop/settings/privacy" }, { href: "/project/shop/settings/sdk" }];

  it("picks the longest href the path is at or under", () => {
    expect(activeHref("/project/shop/settings", items)).toBe("/project/shop/settings");
    expect(activeHref("/project/shop/settings/privacy", items)).toBe("/project/shop/settings/privacy");
    expect(activeHref("/project/shop/settings/privacy/extra", items)).toBe("/project/shop/settings/privacy");
  });

  it("matches whole segments only, and nothing outside the section", () => {
    expect(activeHref("/project/shop/settings/sdkx", items)).toBe("/project/shop/settings");
    expect(activeHref("/project/shop/traffic", items)).toBeNull();
  });

  it("keeps an incident's timeline on Incidents and a rule on Alert rules", () => {
    const menu = incidentsMenu("shop", 0).groups[0].items;
    expect(activeHref("/project/shop/incidents/r-1", menu)).toBe("/project/shop/incidents");
    expect(activeHref("/project/shop/incidents/rules/r-1", menu)).toBe("/project/shop/incidents/rules");
    expect(activeHref("/project/shop/incidents/rules/new", menu)).toBe("/project/shop/incidents/rules");
  });
});

describe("section menus", () => {
  it("groups Project settings and hides what the user may not open or is not built", () => {
    const built = new Set(["", "environments", "sdk", "capture", "privacy", "retention", "ingest", "usage", "alerts", "health-checks", "integrations", "danger"]);
    const admin = projectSettingsMenu("shop", { shop: ["project.delete"] }, built);
    expect(admin.title).toBe("Project settings");
    expect(shown(admin)).toEqual([
      { title: "Project", items: ["General", "Environments", "SDK setup"] },
      { title: "Data", items: ["Capture", "Privacy", "Retention", "Ingest health", "Usage"] },
      { title: "Alerting", items: ["Alert channels", "Health checks"] },
      { title: "More", items: ["Integrations", "Danger zone"] },
    ]);
    expect(admin.groups[3].items.find((i) => i.label === "Danger zone")?.tone).toBe("danger");

    const viewer = projectSettingsMenu("shop", { shop: [] }, new Set(["", "sdk"]));
    expect(shown(viewer).flatMap((g) => g.items)).toEqual(["General", "SDK setup"]);
  });

  it("lists Access with Activity only for audit.read", () => {
    expect(shown(accessMenu("shop", { shop: ["audit.read"] }))[0].items).toEqual(["Members", "API keys", "Activity"]);
    expect(shown(accessMenu("shop", { shop: [] }))[0].items).toEqual(["Members", "API keys"]);
  });

  it("badges Incidents with the open count", () => {
    expect(incidentsMenu("shop", 3).groups[0].items[0].badge).toBe("3");
    expect(incidentsMenu("shop", 0).groups[0].items[0].badge).toBe("");
    expect(incidentsMenu("shop", 0).groups[0].items.map((i) => i.href)).toEqual(["/project/shop/incidents", "/project/shop/incidents/rules"]);
  });

  it("shows Audit log to owners and admins only", () => {
    expect(shown(orgSettingsMenu("acme", "owner"))[0].items).toEqual(["General", "SSO", "Audit log"]);
    expect(shown(orgSettingsMenu("acme", "member"))[0].items).toEqual(["General", "SSO"]);
    expect(orgSettingsMenu("acme", "owner").groups[0].items[0].href).toBe("/org/acme/general");
  });

  it("lists every account section, Danger zone in the danger tone", () => {
    const menu = accountMenu();
    expect(menu.title).toBe("Account settings");
    expect(menu.groups[0].items[0]).toMatchObject({ label: "Profile", href: "/settings" });
    expect(menu.groups[0].items.at(-1)).toMatchObject({ label: "Danger zone", tone: "danger" });
  });
});
