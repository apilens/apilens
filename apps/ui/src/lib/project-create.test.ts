import { describe, expect, it } from "vitest";
import type { ContextOrg } from "./identity";
import { MAX_ENVIRONMENTS, addEnvironments, createProjectError, envError, projectOrg } from "./project-create";

describe("addEnvironments", () => {
  it("adds every separated name", () => {
    expect(addEnvironments(["production"], " dev, qa;eu-west.1 ")).toEqual({ envs: ["production", "dev", "qa", "eu-west.1"] });
  });

  it.each([
    ["-bad", "invalid"],
    ["b!", "invalid"],
    ["x".repeat(65), "invalid"],
    ["production", "duplicate"],
  ])("stops at %j (%s), keeping the names before it", (name, error) => {
    const res = addEnvironments(["production"], `dev ${name}`);
    expect(res.error).toBe(error);
    expect(res.envs).toEqual(["production", "dev"]);
  });

  it("refuses more than the API allows", () => {
    const full = Array.from({ length: MAX_ENVIRONMENTS }, (_, i) => `e${i}`);
    expect(addEnvironments(full, "one-more")).toMatchObject({ envs: full, error: "full", rejected: "one-more" });
  });

  it("ignores empty input", () => {
    expect(addEnvironments(["production"], " , ")).toEqual({ envs: ["production"] });
  });

  it("explains each refusal", () => {
    expect(envError("invalid", "a!")).toContain("“a!” isn’t a valid name");
    expect(envError("duplicate", "dev")).toContain("already in the list");
    expect(envError("full", "x")).toContain(`at most ${MAX_ENVIRONMENTS}`);
  });
});

describe("projectOrg", () => {
  const org = (slug: string, role: ContextOrg["role"]): ContextOrg => ({ id: slug, slug, name: slug, role, projects: [] });
  const orgs = [org("acme", "viewer"), org("beta", "member"), org("example-co", "owner")];

  it("prefers the organization saved on the organization step", () => {
    expect(projectOrg({ orgs }, "example-co")?.slug).toBe("example-co");
  });

  it("falls back to the first organization the user can create projects in", () => {
    expect(projectOrg({ orgs }, "gone")?.slug).toBe("beta");
    expect(projectOrg({ orgs }, "acme")?.slug).toBe("beta");
    expect(projectOrg({ orgs })?.slug).toBe("beta");
  });

  it("answers undefined without such an organization", () => {
    expect(projectOrg({ orgs: [org("acme", "viewer")] })).toBeUndefined();
    expect(projectOrg({ orgs: [] })).toBeUndefined();
  });
});

describe("createProjectError", () => {
  it.each([
    ["invalid_request", "isn’t allowed"],
    ["forbidden", "can’t create projects"],
    ["rate_limited", "Too many attempts"],
    ["network_error", "couldn’t reach APILens"],
    ["something_else", "couldn’t create your project"],
  ])("%s", (code, text) => {
    expect(createProjectError(code)).toContain(text);
  });
});
