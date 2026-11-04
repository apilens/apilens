import { describe, expect, it } from "vitest";
import type { UserContext } from "./identity";
import { parseOnboardingSave, saveError, savedAnswers } from "./onboarding-save";

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

describe("parseOnboardingSave", () => {
  it("accepts a step and answers that fit the API's rules", () => {
    expect(parseOnboardingSave("project", { org_slug: "example-co", language: "python", runtime: "fastapi", method: "sdk", invited: 3 })).toEqual({
      step: "project",
      answers: { org_slug: "example-co", language: "python", runtime: "fastapi", method: "sdk", invited: 3 },
    });
  });

  it("allows saving only answers, only a step, or empty answers", () => {
    expect(parseOnboardingSave(undefined, { project_slug: "shop" })).toEqual({ answers: { project_slug: "shop" } });
    expect(parseOnboardingSave("join", undefined)).toEqual({ step: "join" });
    expect(parseOnboardingSave(null, {})).toEqual({ answers: {} });
    // Empty answers clear a choice, as the API allows.
    expect(parseOnboardingSave("create", { org_slug: "" })).toEqual({ step: "create", answers: { org_slug: "" } });
  });

  it.each([
    ["a step with capitals", "Project", {}],
    ["a step that is a path", "../admin", {}],
    ["a step that is too long", "a".repeat(33), {}],
    ["a step of the wrong type", 7, {}],
    ["an unknown answer", "join", { home: "requests" }],
    ["a slug with capitals", "create", { org_slug: "Example" }],
    ["a slug starting with a dash", "create", { org_slug: "-example" }],
    ["a slug that is too long", "create", { project_slug: "a".repeat(64) }],
    ["a language with spaces", "instrument", { language: "type script" }],
    ["a negative invite count", "invite", { invited: -1 }],
    ["a fractional invite count", "invite", { invited: 1.5 }],
    ["too many invites", "invite", { invited: 1001 }],
    ["an invite count as text", "invite", { invited: "3" }],
    ["answers that are not an object", "join", "org_slug=acme"],
    ["answers that are a list", "join", ["acme"]],
  ])("refuses %s", (_, step, answers) => {
    expect(parseOnboardingSave(step, answers)).toBeNull();
  });
});

describe("savedAnswers", () => {
  it("reads the answers stored on the user", () => {
    expect(savedAnswers(ctx({ org_slug: "example-co", project_slug: "shop", invited: 2 }))).toEqual({
      org_slug: "example-co",
      project_slug: "shop",
      invited: 2,
    });
  });

  it("drops values that do not fit, one by one", () => {
    expect(savedAnswers(ctx({ org_slug: "Bad Slug", language: "python", invited: "2", extra: "x" }))).toEqual({ language: "python" });
  });

  it.each([undefined, null, "acme", 3])("is empty when nothing usable is stored (%j)", (answers) => {
    expect(savedAnswers(ctx(answers))).toEqual({});
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
