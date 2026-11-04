import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const updateOnboarding = vi.fn();
const context = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});

vi.mock("next/headers", () => ({ cookies: async () => ({}), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ updateOnboarding, context }),
}));
vi.mock("@/lib/server-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/server-session")>()),
  withActionSession: async <T,>(fn: (s: { call: <R>(f: (o: { accessToken: string }) => Promise<R>) => Promise<R> }) => Promise<T>) =>
    fn({ call: (f) => f({ accessToken: "a" }) }),
}));

const { openProject } = await import("./actions");

describe("openProject", () => {
  beforeEach(() => {
    updateOnboarding.mockReset();
    context.mockReset();
    redirect.mockClear();
  });

  const ctx = (home?: string) => ({ user: { preferences: home ? { home } : {} }, orgs: [{ slug: "example-co", projects: [{ slug: "checkout" }] }] });

  it("finishes onboarding and opens the project on its home view, without the setup reminder", async () => {
    context.mockResolvedValue(ctx());
    updateOnboarding.mockResolvedValue({});
    await expect(openProject("checkout")).rejects.toThrow("NEXT_REDIRECT");
    expect(updateOnboarding.mock.calls[0][0]).toEqual({ completed: true });
    expect(redirect).toHaveBeenCalledWith("/checkout/incidents");
  });

  it("opens the view the user picked as home", async () => {
    context.mockResolvedValue(ctx("explore"));
    updateOnboarding.mockResolvedValue({});
    await expect(openProject("checkout")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/checkout/explore");
  });

  it("refuses a project the user is not in", async () => {
    context.mockResolvedValue(ctx());
    expect(await openProject("other")).toMatchObject({ ok: false });
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("refuses a project that is not a slug without calling the API", async () => {
    expect(await openProject("../admin")).toMatchObject({ ok: false });
    expect(context).not.toHaveBeenCalled();
  });

  it("answers a sentence when finishing fails", async () => {
    context.mockResolvedValue(ctx());
    updateOnboarding.mockRejectedValue(new ApiError({ status: 503, code: "unavailable" }));
    expect(await openProject("checkout")).toMatchObject({ ok: false, error: expect.stringContaining("finish setup") });
    expect(redirect).not.toHaveBeenCalled();
  });
});
