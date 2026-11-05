import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const createSavedView = vi.fn();
const updateSavedView = vi.fn();
const deleteSavedView = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createSavedView, updateSavedView, deleteSavedView }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { createExploreView, deleteExploreView, updateExploreView } = await import("./actions");

const ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const SAVED = { id: ID, name: "Prod 5xx", surface: "explore", filter: { env: "production", status: "5xx" }, shared: true, created_by: "u1", created_at: "2026-11-05T10:00:00Z", updated_at: "2026-11-05T10:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createExploreView", () => {
  it("saves the checked view as the signed-in user, keeping only filters the log reads", async () => {
    createSavedView.mockResolvedValue(SAVED);
    await expect(createExploreView("shop", { name: "  Prod 5xx ", filter: { env: "production", status: "5XX", bogus: "x", method: "g3t" }, shared: true })).resolves.toEqual({ ok: true, view: SAVED });
    expect(createSavedView).toHaveBeenCalledWith("shop", { name: "Prod 5xx", surface: "explore", filter: { env: "production", status: "5xx" }, shared: true }, { accessToken: "a" });
  });

  it("refuses bad input without calling the API", async () => {
    await expect(createExploreView("Not A Slug", { name: "x", filter: {}, shared: false })).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(createExploreView("shop", { name: " ", filter: {}, shared: false })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(createExploreView("shop", { name: "x".repeat(129), filter: {}, shared: false })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(createExploreView("shop", { name: "x", filter: {} })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(createExploreView("shop", null)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(createSavedView).not.toHaveBeenCalled();
  });

  it("answers a sentence for API errors", async () => {
    createSavedView.mockImplementation(async () => {
      throw new ApiError({ status: 409, code: "conflict" });
    });
    await expect(createExploreView("shop", { name: "x", filter: {}, shared: false })).resolves.toEqual({ ok: false, error: "You already have a view with this name.", code: "conflict" });
  });
});

describe("updateExploreView", () => {
  it("replaces the view as the signed-in user", async () => {
    updateSavedView.mockResolvedValue(SAVED);
    await expect(updateExploreView("shop", ID, { name: "Prod 5xx", filter: { status: "5xx" }, shared: false })).resolves.toEqual({ ok: true, view: SAVED });
    expect(updateSavedView).toHaveBeenCalledWith("shop", ID, { name: "Prod 5xx", filter: { status: "5xx" }, shared: false }, { accessToken: "a" });
  });

  it("refuses an id that is not a view's", async () => {
    await expect(updateExploreView("shop", "../x", { name: "x", filter: {}, shared: false })).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(updateExploreView("shop", "pending:1", { name: "x", filter: {}, shared: false })).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(updateSavedView).not.toHaveBeenCalled();
  });

  it("answers a sentence when the caller may not change it", async () => {
    updateSavedView.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(updateExploreView("shop", ID, { name: "x", filter: {}, shared: true })).resolves.toEqual({ ok: false, error: "Only the view’s creator or a project admin can change it.", code: "forbidden" });
  });
});

describe("deleteExploreView", () => {
  it("deletes the view as the signed-in user", async () => {
    deleteSavedView.mockResolvedValue(undefined);
    await expect(deleteExploreView("shop", ID)).resolves.toEqual({ ok: true });
    expect(deleteSavedView).toHaveBeenCalledWith("shop", ID, { accessToken: "a" });
  });

  it("answers a sentence for API errors", async () => {
    await expect(deleteExploreView("shop", 7)).resolves.toMatchObject({ ok: false, code: "not_found" });
    deleteSavedView.mockImplementation(async () => {
      throw new ApiError({ status: 404, code: "not_found" });
    });
    await expect(deleteExploreView("shop", ID)).resolves.toEqual({ ok: false, error: "That view no longer exists. Reload the page to see the current views.", code: "not_found" });
  });
});
