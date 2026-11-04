import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ContextOrg } from "@/lib/identity";

const createProject = vi.fn();
const context = vi.fn();

vi.mock("next/headers", () => ({ cookies: async () => ({}), headers: async () => new Headers() }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createProject, context }),
}));
vi.mock("@/lib/server-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/server-session")>()),
  withActionSession: async <T,>(fn: (s: { call: <R>(f: (o: { accessToken: string }) => Promise<R>) => Promise<R> }) => Promise<T>) =>
    fn({ call: (f) => f({ accessToken: "a" }) }),
}));

const { createProject: create } = await import("./actions");

const org = (slug: string, projects: string[]): ContextOrg => ({
  id: `o_${slug}`,
  slug,
  name: slug,
  role: "owner",
  projects: projects.map((p) => ({ id: `p_${p}`, slug: p, name: p, environments: ["production"] })),
});
const taken = (suggestions?: unknown) =>
  new ApiError({ status: 409, code: "slug_taken", problem: { code: "slug_taken", suggestions: suggestions as string[] } });

describe("createProject", () => {
  beforeEach(() => {
    createProject.mockReset();
    context.mockReset();
  });

  it("creates the project in the organization with the trimmed name and unique environments", async () => {
    createProject.mockResolvedValue({ id: "p1", slug: "checkout", name: "Checkout", environments: ["production", "staging"] });
    expect(await create("example-co", "  Checkout ", "checkout", ["production", "staging", "production"])).toEqual({ ok: true, slug: "checkout" });
    expect(createProject.mock.calls[0][0]).toBe("example-co");
    expect(createProject.mock.calls[0][1]).toEqual({ name: "Checkout", slug: "checkout", environments: ["production", "staging"] });
  });

  it.each([
    ["Bad Org", "Checkout", "checkout", ["production"]],
    ["example-co", "", "checkout", ["production"]],
    ["example-co", "x".repeat(101), "checkout", ["production"]],
    ["example-co", "Checkout", "Bad Slug", ["production"]],
    ["example-co", "Checkout", "checkout", []],
    ["example-co", "Checkout", "checkout", ["-bad"]],
    ["example-co", "Checkout", "checkout", Array.from({ length: 21 }, (_, i) => `e${i}`)],
  ])("refuses org %j, name %j, slug %j and environments %j without calling the API", async (o, name, slug, envs) => {
    const res = await create(o, name, slug, envs);
    expect(res).toMatchObject({ ok: false, code: "invalid_request" });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("answers slug_taken with the API's suggestions when someone else has it", async () => {
    createProject.mockRejectedValue(taken(["shop-api", "shop-2"]));
    context.mockResolvedValue({ orgs: [org("example-co", [])] });
    expect(await create("example-co", "Shop", "shop", ["production"])).toEqual({ ok: false, code: "slug_taken", suggestions: ["shop-api", "shop-2"] });
  });

  it("counts an address that is already a project of the organization as created", async () => {
    createProject.mockRejectedValue(taken());
    context.mockResolvedValue({ orgs: [org("example-co", ["checkout"])] });
    expect(await create("example-co", "Checkout", "checkout", ["production"])).toEqual({ ok: true, slug: "checkout" });
  });

  it("does not count a project of another organization as created", async () => {
    createProject.mockRejectedValue(taken());
    context.mockResolvedValue({ orgs: [org("example-co", []), org("other", ["checkout"])] });
    expect(await create("example-co", "Checkout", "checkout", ["production"])).toMatchObject({ ok: false, code: "slug_taken" });
  });

  it("answers other API errors with a sentence", async () => {
    createProject.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    const res = await create("example-co", "Checkout", "checkout", ["production"]);
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(res).toHaveProperty("error", expect.stringContaining("can’t create projects"));
  });

  it("rethrows anything that is not an API error", async () => {
    createProject.mockRejectedValue(new Error("boom"));
    await expect(create("example-co", "Checkout", "checkout", ["production"])).rejects.toThrow("boom");
  });
});
