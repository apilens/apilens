import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const getProject = vi.fn();
const pauseProject = vi.fn();
const renameProject = vi.fn();
const deleteProject = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ getProject, pauseProject, renameProject, deleteProject }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { deleteProjectNow, pauseProjectIngest, renameProjectSlug } = await import("./danger-actions");

const SHOP = { slug: "shop", name: "Shop", paused_at: null };
const fails = (status: number, code: string) => async () => {
  throw new ApiError({ status, code });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pauseProjectIngest", () => {
  it("pauses once the typed name matches the project's name", async () => {
    getProject.mockResolvedValue(SHOP);
    pauseProject.mockResolvedValue({ ...SHOP, paused_at: "2026-11-13T10:00:00Z" });
    await expect(pauseProjectIngest("shop", " Shop ")).resolves.toMatchObject({ ok: true, project: { paused_at: "2026-11-13T10:00:00Z" } });
    expect(pauseProject).toHaveBeenCalledWith("shop", { accessToken: "a" });
    // Every project page shows the paused banner (#823).
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("refuses a wrong name, a bad slug or no name without pausing", async () => {
    getProject.mockResolvedValue(SHOP);
    await expect(pauseProjectIngest("shop", "shop")).resolves.toEqual({
      ok: false,
      error: "Type the project’s name exactly to confirm.",
      code: "confirmation_mismatch",
    });
    await expect(pauseProjectIngest("shop", 42)).resolves.toMatchObject({ ok: false, code: "confirmation_mismatch" });
    await expect(pauseProjectIngest("../x", "Shop")).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(pauseProject).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("explains API errors", async () => {
    getProject.mockResolvedValue(SHOP);
    pauseProject.mockImplementation(fails(403, "forbidden"));
    await expect(pauseProjectIngest("shop", "Shop")).resolves.toEqual({ ok: false, error: "Only project admins can do this. Ask a project admin.", code: "forbidden" });
  });
});

describe("renameProjectSlug", () => {
  it("renames, trimmed, and refreshes every link that carries the slug", async () => {
    renameProject.mockResolvedValue({ ...SHOP, slug: "shop-api", canonical_slug: "shop-api" });
    await expect(renameProjectSlug("shop", " shop-api ")).resolves.toMatchObject({ ok: true, project: { slug: "shop-api" } });
    expect(renameProject).toHaveBeenCalledWith("shop", "shop-api", { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("refuses an invalid or unchanged slug without calling the API", async () => {
    await expect(renameProjectSlug("shop", "Shop API")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(renameProjectSlug("shop", "shop")).resolves.toEqual({ ok: false, error: "That is already the project’s address.", code: "invalid_request" });
    await expect(renameProjectSlug("shop", null)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(renameProjectSlug("Not A Slug", "x-y")).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(renameProject).not.toHaveBeenCalled();
  });

  it("passes reauth_required on for the dialog and explains a taken slug", async () => {
    renameProject.mockImplementation(fails(403, "reauth_required"));
    await expect(renameProjectSlug("shop", "shop-api")).resolves.toMatchObject({ ok: false, code: "reauth_required" });
    renameProject.mockImplementation(fails(409, "slug_taken"));
    await expect(renameProjectSlug("shop", "storefront")).resolves.toEqual({ ok: false, error: "That address is taken or reserved. Try another one.", code: "slug_taken" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteProjectNow", () => {
  const DELETED = { id: "p1", slug: "shop", name: "Shop", deleted_at: "2026-11-13T10:00:00Z", purge_after: "2026-11-20T10:00:00Z" };

  it("deletes with the typed slug and refreshes the switcher", async () => {
    deleteProject.mockResolvedValue(DELETED);
    await expect(deleteProjectNow("shop", "shop ")).resolves.toEqual({ ok: true, deleted: DELETED });
    expect(deleteProject).toHaveBeenCalledWith("shop", "shop", { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("refuses the wrong phrase without calling the API", async () => {
    await expect(deleteProjectNow("shop", "Shop")).resolves.toEqual({ ok: false, error: "Type the project’s address exactly to confirm.", code: "confirmation_mismatch" });
    await expect(deleteProjectNow("shop", "")).resolves.toMatchObject({ ok: false, code: "confirmation_mismatch" });
    await expect(deleteProjectNow("shop", undefined)).resolves.toMatchObject({ ok: false, code: "confirmation_mismatch" });
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("explains API errors and passes reauth_required on", async () => {
    deleteProject.mockImplementation(fails(403, "reauth_required"));
    await expect(deleteProjectNow("shop", "shop")).resolves.toMatchObject({ ok: false, code: "reauth_required" });
    deleteProject.mockImplementation(fails(404, "not_found"));
    await expect(deleteProjectNow("shop", "shop")).resolves.toEqual({
      ok: false,
      error: "This project no longer exists, or you no longer have access. Reload the page.",
      code: "not_found",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
