import { describe, expect, it } from "vitest";
import type { UserContext } from "./identity";
import { parseHome, saveError, savedAnswers, savedHome } from "./onboarding-save";

function ctx(answers?: unknown): UserContext {
  return {
    user: {
      id: "u1",
      email: "grace@example.com",
      email_verified: true,
      name: "Grace Hopper",
      avatar_url: null,
      preferences: {},
      onboarding: { step: "create", completed: false, ...(answers === undefined ? {} : { answers: answers as Record<string, unknown> }) },
      created_at: "2026-11-01T00:00:00Z",
    },
    orgs: [],
    last_project_slug: null,
    onboarding: { step: "create", completed: false },
    capabilities: {},
  };
}

describe("savedAnswers", () => {
  it("reads the answers stored on the user", () => {
    expect(savedAnswers(ctx({ org_slug: "example-co", project_slug: "shop" }))).toEqual({
      org_slug: "example-co",
      project_slug: "shop",
    });
  });

  it("drops values that do not fit, one by one", () => {
    expect(savedAnswers(ctx({ org_slug: "Bad Slug", project_slug: "shop", language: "python" }))).toEqual({ project_slug: "shop" });
  });

  it.each([undefined, null, "acme", 3])("is empty when nothing usable is stored (%j)", (answers) => {
    expect(savedAnswers(ctx(answers))).toEqual({});
  });
});

describe("parseHome", () => {
  it.each(["endpoints", "requests", "exceptions"])("accepts %s", (home) => {
    expect(parseHome(home)).toBe(home);
  });

  it.each(["dashboard", "Requests", "", null, undefined, 1])("refuses %j", (home) => {
    expect(parseHome(home)).toBeNull();
  });
});

describe("savedHome", () => {
  function withHome(home: unknown): UserContext {
    const c = ctx();
    return { ...c, user: { ...c.user, preferences: { home } as never } };
  }

  it("reads the home screen saved on the user", () => {
    expect(savedHome(withHome("requests"))).toBe("requests");
  });

  it.each([undefined, "dashboard", 3])("falls back to the default when none usable is saved (%j)", (home) => {
    expect(savedHome(withHome(home))).toBe("endpoints");
  });
});

describe("saveError", () => {
  it("answers a sentence for every code", () => {
    expect(saveError("invalid_request")).toMatch(/weren’t accepted/);
    expect(saveError("network_error")).toMatch(/couldn’t reach APILens/);
    expect(saveError("rate_limited")).toMatch(/Wait a moment/);
    expect(saveError("internal")).toBe("We couldn’t save your progress. Try again in a moment.");
  });
});
