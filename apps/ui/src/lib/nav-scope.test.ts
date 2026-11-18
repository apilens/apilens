import { describe, expect, it } from "vitest";
import { PROJECT_SETTINGS, VIEWS } from "./data";
import { sidebarHref, withScope } from "./nav-scope";

describe("sidebarHref", () => {
  it("keeps range and env from the current page", () => {
    expect(sidebarHref("shop", "errors", new URLSearchParams("range=7d&env=production"))).toBe("/project/shop/errors?range=7d&env=production");
  });

  it("keeps the scope on every sidebar link", () => {
    const current = new URLSearchParams("range=6h&env=staging");
    for (const slug of [...VIEWS.map((v) => v.slug), PROJECT_SETTINGS.slug]) {
      expect(sidebarHref("shop", slug, current)).toBe(`/project/shop/${slug}?range=6h&env=staging`);
    }
  });

  it("leaves every other param of the current page behind", () => {
    expect(sidebarHref("shop", "traffic", new URLSearchParams("tab=issues&page=3&code=500&range=1h"))).toBe("/project/shop/traffic?range=1h");
  });

  it("is the bare page without a scope", () => {
    expect(sidebarHref("shop", "incidents", new URLSearchParams(""))).toBe("/project/shop/incidents");
    expect(sidebarHref("shop", "incidents", null)).toBe("/project/shop/incidents");
  });

  it("keeps only env when only env is set", () => {
    expect(sidebarHref("shop", "performance", new URLSearchParams("env=staging"))).toBe("/project/shop/performance?env=staging");
  });

  it("drops empty and over-long values", () => {
    expect(sidebarHref("shop", "explore", new URLSearchParams(`range=&env=${"x".repeat(65)}`))).toBe("/project/shop/explore");
  });

  it("carries env=all only to the pages that read it as all environments (#993)", () => {
    const current = new URLSearchParams("range=6h&env=all");
    expect(sidebarHref("shop", "errors", current)).toBe("/project/shop/errors?range=6h&env=all");
    expect(sidebarHref("shop", "performance", current)).toBe("/project/shop/performance?range=6h&env=all");
    expect(sidebarHref("shop", "explore", current)).toBe("/project/shop/explore?range=6h");
    expect(withScope("/project/shop/changes", current)).toBe("/project/shop/changes?range=6h");
  });

  it("encodes the values it carries", () => {
    expect(sidebarHref("shop", "traffic", new URLSearchParams("env=eu+west%2F1"))).toBe("/project/shop/traffic?env=eu+west%2F1");
  });
});

describe("withScope", () => {
  it("does not override a param the link already sets", () => {
    expect(withScope("/project/shop/settings?range=24h", new URLSearchParams("range=7d&env=prod"))).toBe("/project/shop/settings?range=24h&env=prod");
  });
});
