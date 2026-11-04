import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ContextOrg } from "@/lib/identity";

const createOrg = vi.fn();
const context = vi.fn();

vi.mock("next/headers", () => ({ cookies: async () => ({}), headers: async () => new Headers() }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createOrg, context }),
}));
vi.mock("@/lib/server-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/server-session")>()),
  withActionSession: async <T,>(fn: (s: { call: <R>(f: (o: { accessToken: string }) => Promise<R>) => Promise<R> }) => Promise<T>) =>
    fn({ call: (f) => f({ accessToken: "a" }) }),
}));

const { createOrganization } = await import("./actions");

const org = (slug: string, role: ContextOrg["role"]): ContextOrg => ({ id: `o_${slug}`, slug, name: slug, role, projects: [] });
const taken = (suggestions?: unknown) =>
  new ApiError({ status: 409, code: "slug_taken", problem: { code: "slug_taken", suggestions: suggestions as string[] } });

describe("createOrganization", () => {
  beforeEach(() => {
    createOrg.mockReset();
    context.mockReset();
  });

  it("creates the organization with the trimmed name", async () => {
    createOrg.mockResolvedValue({ id: "o1", slug: "example-co", name: "Example Co", role: "owner" });
    expect(await createOrganization("  Example Co ", "example-co")).toEqual({ ok: true, slug: "example-co" });
    expect(createOrg.mock.calls[0][0]).toEqual({ name: "Example Co", slug: "example-co" });
  });

  it.each([
    ["", "example-co"],
    ["x".repeat(101), "example-co"],
    ["Example", "Bad Slug"],
    ["Example", "-x"],
  ])("refuses name %j and slug %j without calling the API", async (name, slug) => {
    const res = await createOrganization(name, slug);
    expect(res).toMatchObject({ ok: false, code: "invalid_request" });
    expect(createOrg).not.toHaveBeenCalled();
  });

  it("answers slug_taken with the API's suggestions when someone else has it", async () => {
    createOrg.mockRejectedValue(taken(["acme-hq", "acme-2"]));
    context.mockResolvedValue({ orgs: [org("acme", "member")] });
    expect(await createOrganization("Acme", "acme")).toEqual({ ok: false, code: "slug_taken", suggestions: ["acme-hq", "acme-2"] });
  });

  it("counts an address the user already owns as created", async () => {
    createOrg.mockRejectedValue(taken());
    context.mockResolvedValue({ orgs: [org("example-co", "owner")] });
    expect(await createOrganization("Example Co", "example-co")).toEqual({ ok: true, slug: "example-co" });
  });

  it("answers other API errors with a sentence", async () => {
    createOrg.mockRejectedValue(new ApiError({ status: 0, code: "network_error" }));
    const res = await createOrganization("Example Co", "example-co");
    expect(res).toMatchObject({ ok: false, code: "network_error" });
    expect(res).toHaveProperty("error", expect.stringContaining("couldn’t reach APILens"));
  });

  it("rethrows anything that is not an API error", async () => {
    createOrg.mockRejectedValue(new Error("boom"));
    await expect(createOrganization("Example Co", "example-co")).rejects.toThrow("boom");
  });
});
