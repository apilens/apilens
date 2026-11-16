import { describe, expect, it } from "vitest";
import { checkRepositoryUrl, commitHref, commitTemplateOf, releaseHref, repositoryError } from "./repository";

describe("checkRepositoryUrl", () => {
  it("accepts an empty link (removes it) and an https link, trimmed", () => {
    expect(checkRepositoryUrl("  ")).toEqual({ ok: true, url: "" });
    expect(checkRepositoryUrl(" https://github.com/acme/shop ")).toEqual({ ok: true, url: "https://github.com/acme/shop" });
    // The host is the API's to judge: an install may allow any host.
    expect(checkRepositoryUrl("https://git.example.com/acme/shop")).toEqual({ ok: true, url: "https://git.example.com/acme/shop" });
  });

  it("refuses what the API always refuses", () => {
    for (const bad of ["github.com/acme/shop", "http://github.com/acme/shop", "git@github.com:acme/shop.git", "https://t@github.com/acme/shop", "https://github.com/acme/shop?x=1", "https://github.com/acme/shop#readme", `https://github.com/${"a".repeat(2048)}`]) {
      expect(checkRepositoryUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe("commitTemplateOf", () => {
  it("mirrors the API's layouts and leaves other hosts alone", () => {
    expect(commitTemplateOf("https://GitHub.com/acme/shop.git/")).toBe("https://github.com/acme/shop/commit/{commit}");
    expect(commitTemplateOf("https://gitlab.com/acme/platform/shop")).toBe("https://gitlab.com/acme/platform/shop/-/commit/{commit}");
    expect(commitTemplateOf("https://bitbucket.org/acme/shop")).toBe("https://bitbucket.org/acme/shop/commits/{commit}");
    expect(commitTemplateOf("https://git.example.com/acme/shop")).toBeNull();
    expect(commitTemplateOf("not a url")).toBeNull();
  });
});

describe("commitHref and releaseHref", () => {
  it("fill the template with the URL-encoded id", () => {
    expect(commitHref("https://github.com/acme/shop/commit/{commit}", "4bf92f3")).toBe("https://github.com/acme/shop/commit/4bf92f3");
    expect(releaseHref("https://github.com/acme/shop/releases/tag/{release}", "v2.5.0 rc/1")).toBe("https://github.com/acme/shop/releases/tag/v2.5.0%20rc%2F1");
  });

  it("answer null without a template or an id", () => {
    expect(commitHref(null, "4bf92f3")).toBeNull();
    expect(commitHref("https://github.com/acme/shop/commit/{commit}", "")).toBeNull();
    expect(releaseHref(undefined, "v1")).toBeNull();
  });
});

describe("repositoryError", () => {
  it("prefers the API's reason for invalid_request", () => {
    expect(repositoryError("invalid_request", "The repository must be on github.com, gitlab.com or bitbucket.org.")).toBe(
      "The repository must be on github.com, gitlab.com or bitbucket.org.",
    );
    expect(repositoryError("invalid_request")).toMatch(/wasn’t accepted/);
    expect(repositoryError("forbidden")).toMatch(/not change/);
    expect(repositoryError("internal_error")).toMatch(/Couldn’t save/);
  });
});
