import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const setDefaultAccessApi = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ setDefaultAccess: setDefaultAccessApi }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { previewDefaultAccess, setDefaultAccess } = await import("./default-access-actions");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("default access actions", () => {
  it("previews with a dry run and sets without one", async () => {
    const dry = { default_access: "org_role", previous_default_access: "org_role", lose_access: 3, dry_run: true };
    setDefaultAccessApi.mockResolvedValueOnce(dry);
    await expect(previewDefaultAccess("shop", "none")).resolves.toEqual({ ok: true, change: dry });
    expect(setDefaultAccessApi).toHaveBeenCalledWith("shop", "none", { dryRun: true }, { accessToken: "a" });

    const done = { default_access: "none", previous_default_access: "org_role", lose_access: 3, dry_run: false };
    setDefaultAccessApi.mockResolvedValueOnce(done);
    await expect(setDefaultAccess("shop", "none")).resolves.toEqual({ ok: true, change: done });
    expect(setDefaultAccessApi).toHaveBeenLastCalledWith("shop", "none", { dryRun: false }, { accessToken: "a" });
  });

  it("refuses bad input without calling the API", async () => {
    await expect(setDefaultAccess("Not A Slug", "none")).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(setDefaultAccess("shop", "admin")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(previewDefaultAccess("shop", null)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(setDefaultAccessApi).not.toHaveBeenCalled();
  });

  it("passes reauth_required through for the re-authentication dialog", async () => {
    setDefaultAccessApi.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "reauth_required" });
    });
    await expect(setDefaultAccess("shop", "viewer")).resolves.toMatchObject({ ok: false, code: "reauth_required" });
  });

  it("answers a sentence for other API errors", async () => {
    setDefaultAccessApi.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(setDefaultAccess("shop", "viewer")).resolves.toEqual({
      ok: false,
      error: "Only project admins can change the default access.",
      code: "forbidden",
    });
  });
});
