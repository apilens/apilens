import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const renameMyPasskey = vi.fn();
const deleteMyPasskey = vi.fn();
let expired = false;

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ renameMyPasskey, deleteMyPasskey }),
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

const { removePasskey, renamePasskey } = await import("./passkey-actions");

const ID = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const passkey = {
  id: ID,
  name: "MacBook",
  aaguid: "00000000-0000-0000-0000-000000000000",
  authenticator: "",
  transports: ["internal"],
  backup_eligible: true,
  backup_state: true,
  created_at: "2026-11-01T10:00:00Z",
  last_used_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
});

describe("renamePasskey", () => {
  it("patches the trimmed name", async () => {
    renameMyPasskey.mockResolvedValue({ ...passkey, name: "Work laptop" });
    expect(await renamePasskey(ID, "  Work laptop ")).toEqual({ ok: true, passkey: { ...passkey, name: "Work laptop" } });
    expect(renameMyPasskey).toHaveBeenCalledWith(ID, { name: "Work laptop" }, { accessToken: "a" });
  });

  it("validates before calling identity", async () => {
    expect(await renamePasskey(ID, "   ")).toEqual({ ok: false, error: "Enter a name." });
    expect(await renamePasskey(ID, "x".repeat(65))).toMatchObject({ ok: false });
    expect(await renamePasskey("../users", "Laptop")).toMatchObject({ ok: false, code: "passkey_gone" });
    expect(renameMyPasskey).not.toHaveBeenCalled();
  });

  it("turns identity errors into a sentence", async () => {
    renameMyPasskey.mockRejectedValue(new ApiError({ status: 410, code: "passkey_gone" }));
    expect(await renamePasskey(ID, "Laptop")).toEqual({ ok: false, code: "passkey_gone", error: "That passkey was already removed." });
  });

  it("sends an expired session to sign-in", async () => {
    expired = true;
    await expect(renamePasskey(ID, "Laptop")).rejects.toMatchObject({ to: expect.stringContaining("session_expired") });
  });
});

describe("removePasskey", () => {
  it("deletes the passkey", async () => {
    deleteMyPasskey.mockResolvedValue(undefined);
    expect(await removePasskey(ID)).toEqual({ ok: true });
    expect(deleteMyPasskey).toHaveBeenCalledWith(ID, { accessToken: "a" });
  });

  it("counts a passkey that is already gone as removed", async () => {
    deleteMyPasskey.mockRejectedValue(new ApiError({ status: 410, code: "passkey_gone" }));
    expect(await removePasskey(ID)).toEqual({ ok: true });
    expect(await removePasskey("not-a-uuid")).toEqual({ ok: true });
    expect(deleteMyPasskey).toHaveBeenCalledTimes(1);
  });

  it("reports other failures", async () => {
    deleteMyPasskey.mockRejectedValue(new ApiError({ status: 503, code: "unavailable" }));
    expect(await removePasskey(ID)).toEqual({ ok: false, code: "unavailable", error: "Something went wrong. Try again." });
  });
});
