import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const listSessions = vi.fn();
const revokeSessionApi = vi.fn();
const revokeOtherSessions = vi.fn();
const revalidatePath = vi.fn();
const deleteCookie = vi.fn();
let expired = false;

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: deleteCookie }), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ listSessions, revokeSession: revokeSessionApi, revokeOtherSessions }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = {
    call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => {
      if (expired) throw new real.SessionExpiredError();
      return fn({ accessToken: "a" });
    },
  };
  return {
    ...real,
    // Same contract as the real one, without cookies: an expired session redirects to sign-in.
    withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => {
      try {
        return await fn(session);
      } catch (err) {
        if (real.isSessionExpired(err)) throw new Redirect(real.SESSION_EXPIRED_PATH);
        throw err;
      }
    },
  };
});

const { revokeSession, signOutOtherSessions } = await import("./actions");

const CURRENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const list = { sessions: [{ id: CURRENT, current: true }, { id: OTHER, current: false }] };

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
  listSessions.mockResolvedValue(list);
  revokeSessionApi.mockResolvedValue(undefined);
});

describe("revokeSession", () => {
  it("revokes another session and revalidates the page", async () => {
    expect(await revokeSession(OTHER)).toEqual({ ok: true, revoked: 1 });
    expect(revokeSessionApi).toHaveBeenCalledWith(OTHER, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/sessions");
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("signs this browser out after revoking the current session", async () => {
    await expect(revokeSession(CURRENT)).rejects.toMatchObject({ to: "/sign-in?reason=signed_out" });
    expect(revokeSessionApi).toHaveBeenCalledWith(CURRENT, { accessToken: "a" });
    expect(deleteCookie).toHaveBeenCalledWith("apilens_session");
  });

  it("treats a session that is already gone as revoked", async () => {
    const gone = "33333333-3333-4333-8333-333333333333";
    expect(await revokeSession(gone)).toEqual({ ok: true, revoked: 1 });
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("checks the id before calling identity", async () => {
    for (const id of ["", "../me", "not-a-uuid", 42 as unknown as string]) {
      expect(await revokeSession(id)).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(listSessions).not.toHaveBeenCalled();
    expect(revokeSessionApi).not.toHaveBeenCalled();
  });

  it("turns API errors into a sentence", async () => {
    revokeSessionApi.mockRejectedValue(new ApiError({ status: 0, code: "network_error" }));
    expect(await revokeSession(OTHER)).toMatchObject({ ok: false, code: "network_error", error: expect.stringMatching(/reach APILens/) });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sends an expired session to sign-in", async () => {
    expired = true;
    await expect(revokeSession(OTHER)).rejects.toMatchObject({ to: expect.stringContaining("session_expired") });
  });
});

describe("signOutOtherSessions", () => {
  it("revokes the others and revalidates the page", async () => {
    revokeOtherSessions.mockResolvedValue({ revoked: 2 });
    expect(await signOutOtherSessions()).toEqual({ ok: true, revoked: 2 });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/sessions");
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("turns API errors into a sentence", async () => {
    revokeOtherSessions.mockRejectedValue(new ApiError({ status: 429, code: "rate_limited" }));
    expect(await signOutOtherSessions()).toMatchObject({ ok: false, code: "rate_limited" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows what is not an API error", async () => {
    revokeOtherSessions.mockRejectedValue(new TypeError("boom"));
    await expect(signOutOtherSessions()).rejects.toThrow("boom");
  });
});
