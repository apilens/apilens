import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const restoreProject = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ restoreProject }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { restoreDeletedProject } = await import("./restore-actions");

const ID = "f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b9c";
const fails = (status: number, code: string) => async () => {
  throw new ApiError({ status, code });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("restoreDeletedProject", () => {
  it("restores and refreshes the switcher", async () => {
    restoreProject.mockResolvedValue({ id: ID, slug: "legacy-checkout", name: "Legacy checkout" });
    await expect(restoreDeletedProject("acme", ID)).resolves.toEqual({ ok: true, project: { slug: "legacy-checkout", name: "Legacy checkout" } });
    expect(restoreProject).toHaveBeenCalledWith("acme", ID, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("refuses a bad organization or id without calling the API", async () => {
    await expect(restoreDeletedProject("../acme", ID)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(restoreDeletedProject("acme", "not-an-id")).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(restoreDeletedProject("acme", 42)).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(restoreProject).not.toHaveBeenCalled();
  });

  it("passes reauth_required on for the dialog and explains other errors", async () => {
    restoreProject.mockImplementation(fails(403, "reauth_required"));
    await expect(restoreDeletedProject("acme", ID)).resolves.toMatchObject({ ok: false, code: "reauth_required" });
    restoreProject.mockImplementation(fails(403, "forbidden"));
    await expect(restoreDeletedProject("acme", ID)).resolves.toEqual({
      ok: false,
      error: "Only organization owners and admins can restore projects.",
      code: "forbidden",
    });
    restoreProject.mockImplementation(fails(404, "not_found"));
    await expect(restoreDeletedProject("acme", ID)).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
