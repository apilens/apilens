import { describe, expect, it } from "vitest";
import { renamedPath } from "./project-redirect";

describe("renamedPath", () => {
  it("keeps the page and query under the new slug", () => {
    expect(renamedPath("/shop/settings/danger", "shop", "shop-api")).toBe("/shop-api/settings/danger");
    expect(renamedPath("/shop/traffic?range=24h", "shop", "shop-api")).toBe("/shop-api/traffic?range=24h");
    expect(renamedPath("/shop", "shop", "shop-api")).toBe("/shop-api");
    expect(renamedPath("/shop?x=1", "shop", "shop-api")).toBe("/shop-api?x=1");
  });

  it("answers the project's root for anything that is not a path under the old slug", () => {
    expect(renamedPath(null, "shop", "shop-api")).toBe("/shop-api");
    expect(renamedPath("/shopping/traffic", "shop", "shop-api")).toBe("/shop-api");
    expect(renamedPath("/shop//evil.example", "shop", "shop-api")).toBe("/shop-api");
    expect(renamedPath("/shop/\\evil.example", "shop", "shop-api")).toBe("/shop-api");
    expect(renamedPath("/other/shop", "shop", "shop-api")).toBe("/shop-api");
  });
});
