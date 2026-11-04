import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const createApiKey = vi.fn();
const updateOnboarding = vi.fn();
const context = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});

vi.mock("next/headers", () => ({ cookies: async () => ({}), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createApiKey, updateOnboarding, context }),
}));
vi.mock("@/lib/server-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/server-session")>()),
  withActionSession: async <T,>(fn: (s: { call: <R>(f: (o: { accessToken: string }) => Promise<R>) => Promise<R> }) => Promise<T>) =>
    fn({ call: (f) => f({ accessToken: "a" }) }),
}));

const { createInstallKey, finishInstallLater } = await import("./actions");

const ID = "0b6f5c7e-8d1a-4c2b-9e3f-1a2b3c4d5e6f";
const created = { id: ID, name: "Onboarding", prefix: "apl_live_0123", key: "apl_live_0123456789", scopes: ["ingest"], last_used_at: null, created_at: "2026-11-04T12:00:00Z", revoked_at: null };

describe("createInstallKey", () => {
  beforeEach(() => {
    createApiKey.mockReset();
    updateOnboarding.mockReset();
  });

  it("creates an ingest-only key named Onboarding and saves its id, never the raw key", async () => {
    createApiKey.mockResolvedValue(created);
    updateOnboarding.mockResolvedValue({});
    expect(await createInstallKey("checkout")).toEqual({ ok: true, key: { id: ID, prefix: "apl_live_0123", key: "apl_live_0123456789" } });
    expect(createApiKey.mock.calls[0][0]).toBe("checkout");
    expect(createApiKey.mock.calls[0][1]).toEqual({ name: "Onboarding", scopes: ["ingest"] });
    expect(updateOnboarding.mock.calls[0][0]).toEqual({ answers: { api_key_id: ID } });
    expect(JSON.stringify(updateOnboarding.mock.calls)).not.toContain("apl_live_0123456789");
  });

  it("still shows the key when saving its id fails", async () => {
    createApiKey.mockResolvedValue(created);
    updateOnboarding.mockRejectedValue(new ApiError({ status: 503, code: "unavailable" }));
    expect(await createInstallKey("checkout")).toMatchObject({ ok: true, key: { id: ID } });
  });

  it("answers API errors with a sentence", async () => {
    createApiKey.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    const res = await createInstallKey("checkout");
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(res).toHaveProperty("error", expect.stringContaining("permission"));
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("refuses a project that is not a slug without calling the API", async () => {
    expect(await createInstallKey("../admin")).toMatchObject({ ok: false, code: "not_found" });
    expect(createApiKey).not.toHaveBeenCalled();
  });
});

describe("finishInstallLater", () => {
  beforeEach(() => {
    updateOnboarding.mockReset();
    context.mockReset();
    redirect.mockClear();
  });

  const ctx = { user: { preferences: {} }, orgs: [{ slug: "example-co", projects: [{ slug: "checkout" }] }] };

  it("finishes onboarding and opens the project with the reminder", async () => {
    context.mockResolvedValue(ctx);
    updateOnboarding.mockResolvedValue({});
    await expect(finishInstallLater("checkout")).rejects.toThrow("NEXT_REDIRECT");
    expect(updateOnboarding.mock.calls[0][0]).toEqual({ completed: true });
    expect(redirect).toHaveBeenCalledWith(expect.stringMatching(/^\/checkout\/[a-z-]+\?setup=later$/));
  });

  it("refuses a project the user is not in", async () => {
    context.mockResolvedValue(ctx);
    expect(await finishInstallLater("other")).toMatchObject({ ok: false });
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("answers a sentence when finishing fails", async () => {
    context.mockResolvedValue(ctx);
    updateOnboarding.mockRejectedValue(new ApiError({ status: 503, code: "unavailable" }));
    expect(await finishInstallLater("checkout")).toMatchObject({ ok: false, error: expect.stringContaining("finish setup") });
    expect(redirect).not.toHaveBeenCalled();
  });
});
