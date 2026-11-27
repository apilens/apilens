import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_NAV, ORG_SETTINGS_ROUTES, TOP_LEVEL_ROUTES, legacyRedirect, newOrgHref, newProjectHref, orgHref, orgNavActive, projectHref } from "./routes";

describe("projectHref", () => {
  it("builds /project/<slug>[/<view>[/<sub>]]", () => {
    expect(projectHref("shop")).toBe("/project/shop");
    expect(projectHref("shop", "traffic")).toBe("/project/shop/traffic");
    expect(projectHref("shop", "settings", "sdk")).toBe("/project/shop/settings/sdk");
    expect(projectHref("shop", "endpoints", "GET/%2Forders")).toBe("/project/shop/endpoints/GET/%2Forders");
  });

  it("encodes the slug, drops a leading slash on sub and ignores sub without a view", () => {
    expect(projectHref("a b", "apps")).toBe("/project/a%20b/apps");
    expect(projectHref("shop", "settings", "/privacy")).toBe("/project/shop/settings/privacy");
    expect(projectHref("shop", undefined, "x")).toBe("/project/shop");
  });
});

describe("orgHref", () => {
  it("builds /org/<slug>[/<section>]", () => {
    expect(orgHref("acme")).toBe("/org/acme");
    expect(orgHref("acme", "")).toBe("/org/acme");
    expect(orgHref("acme", "team")).toBe("/org/acme/team");
    expect(orgHref("acme", "general")).toBe("/org/acme/general");
    expect(orgHref("acme", "sso")).toBe("/org/acme/sso");
    expect(orgHref("acme", "audit")).toBe("/org/acme/audit");
  });
});

describe("orgNavActive (the org rail)", () => {
  it("marks Projects on the org's home and Team on team", () => {
    expect(orgNavActive("")).toBe("projects");
    expect(orgNavActive("projects")).toBe("projects");
    expect(orgNavActive("team")).toBe("team");
  });

  it("marks Organization settings on every settings route", () => {
    for (const s of ORG_SETTINGS_ROUTES) expect(orgNavActive(s)).toBe("settings");
    expect(ORG_SETTINGS_ROUTES).toEqual(["general", "sso", "audit"]);
  });

  it("marks nothing elsewhere", () => {
    expect(orgNavActive("settings")).toBeNull();
    expect(orgNavActive("billing")).toBeNull();
  });

  it("lists Projects, Team and Organization settings, each landing on a page whose item is on", () => {
    expect(ORG_NAV.map((n) => n.label)).toEqual(["Projects", "Team", "Organization settings"]);
    for (const n of ORG_NAV) expect(orgNavActive(n.section)).toBe(n.item);
  });
});

describe("legacyRedirect", () => {
  it("moves /<project>/... under /project, keeping the rest and the query", () => {
    expect(legacyRedirect("/shop", "")).toBe("/project/shop");
    expect(legacyRedirect("/shop/", "")).toBe("/project/shop");
    expect(legacyRedirect("/shop/traffic", "")).toBe("/project/shop/traffic");
    expect(legacyRedirect("/shop/traffic", "?range=24h&env=prod")).toBe("/project/shop/traffic?range=24h&env=prod");
    expect(legacyRedirect("/shop/settings/danger", "?renamed=old")).toBe("/project/shop/settings/danger?renamed=old");
    expect(legacyRedirect("/shop/endpoints/GET/%2Forders", "")).toBe("/project/shop/endpoints/GET/%2Forders");
  });

  it("moves Changes to Deploys, keeping the deploy and the query (#1051)", () => {
    expect(legacyRedirect("/project/shop/changes", "")).toBe("/project/shop/deploys");
    expect(legacyRedirect("/project/shop/changes", "?range=7d&app=web")).toBe("/project/shop/deploys?range=7d&app=web");
    expect(legacyRedirect("/project/shop/changes/9f3a1b2c", "")).toBe("/project/shop/deploys/9f3a1b2c");
    expect(legacyRedirect("/shop/changes", "?range=7d")).toBe("/project/shop/deploys?range=7d");
    expect(legacyRedirect("/project/shop/deploys", "")).toBeNull();
    expect(legacyRedirect("/project/shop/traffic", "")).toBeNull();
    expect(legacyRedirect("/project/Not_A_Slug/changes", "")).toBeNull();
  });

  it("maps the old organization settings to the new organization pages", () => {
    expect(legacyRedirect("/orgs/acme/settings", "")).toBe("/org/acme/general");
    expect(legacyRedirect("/orgs/acme/settings", "?deleted=shop")).toBe("/org/acme/general?deleted=shop");
    expect(legacyRedirect("/orgs/acme/settings/members", "?q=ada")).toBe("/org/acme/team?q=ada");
    expect(legacyRedirect("/orgs/acme/settings/invitations", "")).toBe("/org/acme/team");
    expect(legacyRedirect("/orgs/acme/settings/sso", "")).toBe("/org/acme/sso");
    expect(legacyRedirect("/orgs/acme/settings/audit", "?project=shop")).toBe("/org/acme/audit?project=shop");
    expect(legacyRedirect("/orgs/acme/settings/whatever", "")).toBe("/org/acme/general");
    expect(legacyRedirect("/orgs/acme", "")).toBe("/org/acme");
    expect(legacyRedirect("/orgs/acme/", "")).toBe("/org/acme");
  });

  it("leaves current URLs, static top-level routes and non-slugs alone", () => {
    for (const path of [
      "/",
      "/org",
      "/org/acme",
      "/org/acme/team",
      "/organizations",
      "/project",
      "/project/shop/traffic",
      "/settings",
      "/settings/security",
      "/design/nav",
      "/api/projects/shop/requests",
      "/api/orgs/acme/audit-export",
      "/auth/callback",
      "/auth/2fa",
      "/invite/tok",
      "/onboarding/welcome",
      "/sign-in",
      "/sign-up",
      "/verify",
      "/_next/data/x.json",
      "/favicon.ico",
      "/Shop/traffic",
      "/orgs",
      "/orgs/acme/other",
      "/orgs/ACME/settings",
    ]) {
      expect(legacyRedirect(path, ""), path).toBeNull();
    }
  });

  it("knows every static top-level route in src/app (route groups included)", () => {
    const app = join(__dirname, "..", "app");
    const dirs = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => (d.name.startsWith("(") ? dirs(join(dir, d.name)) : [d.name]));
    const top = dirs(app).filter((d) => !d.startsWith("[") && !d.startsWith("_"));
    expect(top.length).toBeGreaterThan(5);
    for (const r of top) expect(TOP_LEVEL_ROUTES.has(r), r).toBe(true);
  });
});

describe("the create pages", () => {
  it("names the organization and project create routes", () => {
    expect(newOrgHref()).toBe("/organizations/new");
    expect(newProjectHref("acme")).toBe("/org/acme/projects/new");
  });

  it("encodes an odd organization slug", () => {
    expect(newProjectHref("a b")).toBe("/org/a%20b/projects/new");
  });
});
