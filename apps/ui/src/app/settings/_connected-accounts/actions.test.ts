import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const oauthLinkStart = vi.fn();
const deleteIdentity = vi.fn();
const revalidatePath = vi.fn();
let expired = false;

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ oauthLinkStart, deleteIdentity }),
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

const { connectAccount, disconnectAccount } = await import("./actions");

const ID = "6f1c1a52-3c1e-4c3a-9b6b-0d1d2e3f4a5b";

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
});

describe("connectAccount", () => {
  it("starts a link flow back to this page and sends the browser to the provider", async () => {
    oauthLinkStart.mockResolvedValue("https://accounts.google.com/o/oauth2/auth?state=s");
    await expect(connectAccount("google")).rejects.toMatchObject({ to: "https://accounts.google.com/o/oauth2/auth?state=s" });
    expect(oauthLinkStart).toHaveBeenCalledWith("google", "/settings/connected-accounts", { accessToken: "a" });
  });

  it("refuses an unknown provider without calling identity", async () => {
    await expect(connectAccount("myspace")).resolves.toEqual({ ok: false, error: expect.stringContaining("isn’t available") });
    expect(oauthLinkStart).not.toHaveBeenCalled();
  });

  it("answers a sentence when identity refuses", async () => {
    oauthLinkStart.mockRejectedValue(new ApiError({ status: 404, code: "not_found", message: "x" }));
    await expect(connectAccount("github")).resolves.toEqual({ ok: false, error: expect.stringContaining("isn’t available") });
  });

  it("never redirects to a non-http location", async () => {
    oauthLinkStart.mockResolvedValue("javascript:alert(1)");
    await expect(connectAccount("github")).resolves.toMatchObject({ ok: false });
  });

  it("an expired session goes to sign-in", async () => {
    expired = true;
    await expect(connectAccount("github")).rejects.toMatchObject({ to: "/sign-in?reason=session_expired" });
  });
});

describe("disconnectAccount", () => {
  it("deletes the identity and refreshes the page", async () => {
    deleteIdentity.mockResolvedValue(undefined);
    await expect(disconnectAccount(ID)).resolves.toEqual({ ok: true });
    expect(deleteIdentity).toHaveBeenCalledWith(ID, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/connected-accounts");
  });

  it("an account already gone counts as disconnected", async () => {
    deleteIdentity.mockRejectedValue(new ApiError({ status: 410, code: "oauth_identity_gone", message: "x" }));
    await expect(disconnectAccount(ID)).resolves.toEqual({ ok: true });
  });

  it("refuses a malformed id and reports other failures", async () => {
    await expect(disconnectAccount("../x")).resolves.toMatchObject({ ok: false });
    expect(deleteIdentity).not.toHaveBeenCalled();
    deleteIdentity.mockRejectedValue(new ApiError({ status: 500, code: "internal_error", message: "x" }));
    await expect(disconnectAccount(ID)).resolves.toEqual({ ok: false, error: "Something went wrong. Try again." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
