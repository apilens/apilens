import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const updateProject = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ updateProject }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { saveRepositoryUrl } = await import("./integrations-actions");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveRepositoryUrl", () => {
  it("patches the trimmed link as the signed-in user", async () => {
    const saved = { id: "p", slug: "shop", name: "Shop", environments: [], repository_url: "https://github.com/acme/shop" };
    updateProject.mockResolvedValue(saved);
    await expect(saveRepositoryUrl("shop", " https://github.com/acme/shop ")).resolves.toEqual({ ok: true, project: saved });
    expect(updateProject).toHaveBeenCalledWith("shop", { repository_url: "https://github.com/acme/shop" }, { accessToken: "a" });
  });

  it("sends an empty link to remove it", async () => {
    updateProject.mockResolvedValue({ id: "p", slug: "shop", name: "Shop", environments: [], repository_url: null });
    await saveRepositoryUrl("shop", "");
    expect(updateProject).toHaveBeenCalledWith("shop", { repository_url: "" }, { accessToken: "a" });
  });

  it("refuses bad input without calling the API", async () => {
    await expect(saveRepositoryUrl("Not A Slug", "https://github.com/acme/shop")).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveRepositoryUrl("shop", "http://github.com/acme/shop")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(saveRepositoryUrl("shop", 7)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("answers the API's reason for a refused link", async () => {
    updateProject.mockRejectedValue(
      new ApiError({ status: 400, code: "invalid_request", problem: { detail: "The repository must be on github.com, gitlab.com or bitbucket.org." } }),
    );
    await expect(saveRepositoryUrl("shop", "https://git.example.com/acme/shop")).resolves.toEqual({
      ok: false,
      error: "The repository must be on github.com, gitlab.com or bitbucket.org.",
      code: "invalid_request",
    });
  });
});
