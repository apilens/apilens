import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const updateMe = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ updateMe }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { saveHomeScreen } = await import("./home-actions");

beforeEach(() => vi.clearAllMocks());

describe("saveHomeScreen (Account settings → Home screen, #994)", () => {
  it("persists the pick as the home preference and answers the saved one", async () => {
    updateMe.mockResolvedValue({ id: "u1", email: "you@example.com", preferences: { home: "exceptions" } });
    await expect(saveHomeScreen("exceptions")).resolves.toEqual({ ok: true, home: "exceptions" });
    expect(updateMe).toHaveBeenCalledWith({ preferences: { home: "exceptions" } }, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/preferences");
  });

  it("refuses a home screen the API does not offer without calling it", async () => {
    for (const home of ["incidents", "traffic", "", null, 3]) {
      const result = await saveHomeScreen(home as never);
      expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("answers a sentence when the API refuses", async () => {
    updateMe.mockRejectedValue(new ApiError({ status: 400, code: "invalid_request" }));
    const result = await saveHomeScreen("requests");
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});
