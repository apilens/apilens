import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const api = {
  listEnvironments: vi.fn(),
  addEnvironment: vi.fn(),
  updateEnvironment: vi.fn(),
  reorderEnvironments: vi.fn(),
  removeEnvironment: vi.fn(),
};

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => api,
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { addEnvironment, updateEnvironment, reorderEnvironments, removeEnvironment } = await import("./environments-actions");

const LIST = { environments: [], max_environments: 20 };
const O = { accessToken: "a" };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listEnvironments.mockResolvedValue(LIST);
});

describe("addEnvironment", () => {
  it("adds the trimmed name and answers the list", async () => {
    await expect(addEnvironment("shop", " staging ")).resolves.toEqual({ ok: true, list: LIST });
    expect(api.addEnvironment).toHaveBeenCalledWith("shop", "staging", O);
    expect(api.listEnvironments).toHaveBeenCalledWith("shop", O);
  });

  it("refuses a bad name or project without calling the API", async () => {
    await expect(addEnvironment("shop", "no spaces")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(addEnvironment("shop", 7)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(addEnvironment("Not A Slug", "staging")).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(api.addEnvironment).not.toHaveBeenCalled();
  });

  it("turns an API refusal into a sentence", async () => {
    api.addEnvironment.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    await expect(addEnvironment("shop", "staging")).resolves.toEqual({
      ok: false,
      code: "forbidden",
      error: "Only project admins and editors can change environments. Ask a project admin.",
    });
  });
});

describe("updateEnvironment", () => {
  it("sends only the known fields", async () => {
    await expect(updateEnvironment("shop", "staging", { color: "teal", is_production: false, hidden: true })).resolves.toMatchObject({ ok: true });
    expect(api.updateEnvironment).toHaveBeenCalledWith("shop", "staging", { color: "teal", is_production: false, hidden: true }, O);
    await updateEnvironment("shop", "staging", { color: "none" });
    expect(api.updateEnvironment).toHaveBeenLastCalledWith("shop", "staging", { color: "none" }, O);
  });

  it("refuses unknown fields, bad values and empty patches", async () => {
    for (const patch of [{ color: "#fff" }, { hidden: "yes" }, { position: 1 }, {}, null]) {
      await expect(updateEnvironment("shop", "staging", patch)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    }
    await expect(updateEnvironment("shop", "../x", { hidden: true })).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(api.updateEnvironment).not.toHaveBeenCalled();
  });
});

describe("reorderEnvironments", () => {
  it("answers the list the API returns", async () => {
    const ordered = { environments: [{ name: "staging" }], max_environments: 20 };
    api.reorderEnvironments.mockResolvedValue(ordered);
    await expect(reorderEnvironments("shop", ["staging", "production"])).resolves.toEqual({ ok: true, list: ordered });
    expect(api.reorderEnvironments).toHaveBeenCalledWith("shop", ["staging", "production"], O);
    expect(api.listEnvironments).not.toHaveBeenCalled();
  });

  it("refuses duplicates and non-lists", async () => {
    await expect(reorderEnvironments("shop", ["a", "a"])).resolves.toMatchObject({ ok: false });
    await expect(reorderEnvironments("shop", "a")).resolves.toMatchObject({ ok: false });
    await expect(reorderEnvironments("shop", [])).resolves.toMatchObject({ ok: false });
    expect(api.reorderEnvironments).not.toHaveBeenCalled();
  });
});

describe("removeEnvironment", () => {
  it("says to hide one in use", async () => {
    api.removeEnvironment.mockRejectedValue(new ApiError({ status: 409, code: "environment_in_use" }));
    await expect(removeEnvironment("shop", "staging")).resolves.toMatchObject({ ok: false, code: "environment_in_use", error: expect.stringContaining("Hide it instead") });
  });

  it("removes and answers the list", async () => {
    await expect(removeEnvironment("shop", "preview")).resolves.toEqual({ ok: true, list: LIST });
    expect(api.removeEnvironment).toHaveBeenCalledWith("shop", "preview", O);
  });
});
