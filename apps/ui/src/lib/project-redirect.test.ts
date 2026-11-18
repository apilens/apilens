import { describe, expect, it } from "vitest";
import { renamedPath } from "./project-redirect";

describe("renamedPath", () => {
  it("keeps the page and query under the new slug", () => {
    expect(renamedPath("/project/shop/settings/danger", "shop", "shop-api")).toBe("/project/shop-api/settings/danger");
    expect(renamedPath("/project/shop/traffic?range=24h", "shop", "shop-api")).toBe("/project/shop-api/traffic?range=24h");
    expect(renamedPath("/project/shop", "shop", "shop-api")).toBe("/project/shop-api");
    expect(renamedPath("/project/shop?x=1", "shop", "shop-api")).toBe("/project/shop-api?x=1");
  });

  it("answers the project's root for anything that is not a path under the old slug", () => {
    expect(renamedPath(null, "shop", "shop-api")).toBe("/project/shop-api");
    expect(renamedPath("/project/shopping/traffic", "shop", "shop-api")).toBe("/project/shop-api");
    expect(renamedPath("/project/shop//evil.example", "shop", "shop-api")).toBe("/project/shop-api");
    expect(renamedPath("/project/shop/\\evil.example", "shop", "shop-api")).toBe("/project/shop-api");
    expect(renamedPath("/project/other/shop", "shop", "shop-api")).toBe("/project/shop-api");
    expect(renamedPath("/shop/traffic", "shop", "shop-api")).toBe("/project/shop-api");
  });
});
