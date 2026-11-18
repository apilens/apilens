import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const getProject = vi.fn();
const updateProject = vi.fn();
const resumeProject = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ getProject, updateProject, resumeProject }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { resumeProjectIngest, saveProjectGeneral } = await import("./general-actions");

const CURRENT = { name: "Shop", description: "Storefront API" };
const SAVED = { slug: "shop", name: "Shop API", description: "Storefront API" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveProjectGeneral", () => {
  it("patches only what changed, trimmed, and refreshes the shell for a new name", async () => {
    updateProject.mockResolvedValue(SAVED);
    await expect(saveProjectGeneral("shop", CURRENT, { name: "  Shop API ", description: "Storefront API" })).resolves.toEqual({ ok: true, project: SAVED });
    expect(updateProject).toHaveBeenCalledWith("shop", { name: "Shop API" }, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("clears the description without refreshing the shell", async () => {
    updateProject.mockResolvedValue({ ...SAVED, name: "Shop", description: "" });
    await saveProjectGeneral("shop", CURRENT, { name: "Shop", description: "   " });
    expect(updateProject).toHaveBeenCalledWith("shop", { description: "" }, { accessToken: "a" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("answers the project as it is when nothing changed", async () => {
    getProject.mockResolvedValue({ ...SAVED, name: "Shop" });
    await expect(saveProjectGeneral("shop", CURRENT, CURRENT)).resolves.toMatchObject({ ok: true });
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("refuses bad input without calling the API, naming each field", async () => {
    await expect(saveProjectGeneral("Not A Slug", CURRENT, CURRENT)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveProjectGeneral("shop", CURRENT, { name: 3 })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(saveProjectGeneral("shop", null, CURRENT)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(saveProjectGeneral("shop", CURRENT, { name: " ", description: "x".repeat(281) })).resolves.toEqual({
      ok: false,
      error: "Fix the highlighted fields to save.",
      code: "invalid_request",
      errors: { name: "Enter a project name.", description: "Use at most 280 characters." },
    });
    expect(updateProject).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
  });

  it("answers a sentence for API errors", async () => {
    updateProject.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(saveProjectGeneral("shop", CURRENT, { ...CURRENT, name: "Nope" })).resolves.toEqual({
      ok: false,
      error: "Only project admins and editors can change this. Ask a project admin.",
      code: "forbidden",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("resumeProjectIngest", () => {
  it("resumes as the signed-in user", async () => {
    resumeProject.mockResolvedValue({ ...SAVED, paused_at: null });
    await expect(resumeProjectIngest("shop")).resolves.toMatchObject({ ok: true, project: { paused_at: null } });
    expect(resumeProject).toHaveBeenCalledWith("shop", { accessToken: "a" });
    // Clears the paused banner on every project page (#823).
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("refuses a bad slug and explains API errors", async () => {
    await expect(resumeProjectIngest("../x")).resolves.toMatchObject({ ok: false, code: "not_found" });
    resumeProject.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(resumeProjectIngest("shop")).resolves.toEqual({ ok: false, error: "Only project admins can do this. Ask a project admin.", code: "forbidden" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
