import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const twoFactorStatus = vi.fn();
const twoFactorEnable = vi.fn();
const twoFactorVerify = vi.fn();
const twoFactorDisable = vi.fn();
const twoFactorRegenerate = vi.fn();
const revalidatePath = vi.fn();
const refresh = vi.fn();
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
  identity: () => ({ twoFactorStatus, twoFactorEnable, twoFactorVerify, twoFactorDisable, twoFactorRegenerate }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const { isApiError } = await import("@/lib/identity");
  const session = {
    // Same contract as the real one: a 401 ApiError refreshes once and retries.
    call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => {
      if (expired) throw new real.SessionExpiredError();
      try {
        return await fn({ accessToken: "a" });
      } catch (err) {
        if (!isApiError(err) || err.status !== 401) throw err;
        refresh();
        return fn({ accessToken: "b" });
      }
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

const { confirmTwoFactor, disableTwoFactor, regenerateBackupCodes, startTwoFactor } = await import("./two-factor-actions");

const codes = Array.from({ length: 10 }, (_, i) => `abcd-${String(2000 + i)}`);
const on = { enabled: true, confirmed_at: "2026-11-04T10:00:00Z", backup_codes_remaining: 10 };
const wrong = () => new ApiError({ status: 401, code: "invalid_totp" });

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
});

describe("startTwoFactor", () => {
  it("answers the secret and its otpauth URI", async () => {
    twoFactorEnable.mockResolvedValue({ secret: "JBSWY3DP", otpauth_uri: "otpauth://totp/x" });
    expect(await startTwoFactor()).toEqual({ ok: true, secret: "JBSWY3DP", otpauthUri: "otpauth://totp/x" });
  });

  it("says when a fresh sign-in is needed", async () => {
    twoFactorEnable.mockRejectedValue(new ApiError({ status: 403, code: "reauth_required" }));
    expect(await startTwoFactor()).toMatchObject({ ok: false, code: "reauth_required", error: expect.stringMatching(/sign in again/) });
  });

  it("sends an expired session to sign-in", async () => {
    expired = true;
    await expect(startTwoFactor()).rejects.toMatchObject({ to: expect.stringContaining("session_expired") });
  });
});

describe("confirmTwoFactor", () => {
  it("answers the backup codes and the new status", async () => {
    twoFactorVerify.mockResolvedValue({ backup_codes: codes });
    twoFactorStatus.mockResolvedValue(on);
    expect(await confirmTwoFactor("123456")).toEqual({ ok: true, backupCodes: codes, status: on });
    expect(twoFactorVerify).toHaveBeenCalledWith({ code: "123456" }, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/security");
  });

  it("still answers the codes when the status read fails", async () => {
    twoFactorVerify.mockResolvedValue({ backup_codes: codes });
    twoFactorStatus.mockRejectedValue(new ApiError({ status: 503, code: "unavailable" }));
    expect(await confirmTwoFactor("123456")).toMatchObject({ ok: true, backupCodes: codes, status: { enabled: true, backup_codes_remaining: 10 } });
  });

  it("a wrong code is an answer, not an expired session: no refresh, no retry", async () => {
    twoFactorVerify.mockRejectedValue(wrong());
    expect(await confirmTwoFactor("000000")).toMatchObject({ ok: false, code: "invalid_totp", error: expect.stringMatching(/^Wrong code\./) });
    expect(twoFactorVerify).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("checks the code before calling identity", async () => {
    for (const bad of ["12345", "abcdef", 123456 as unknown as string]) {
      expect(await confirmTwoFactor(bad)).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(twoFactorVerify).not.toHaveBeenCalled();
  });
});

describe("disableTwoFactor", () => {
  it("turns it off with a code or a backup code", async () => {
    twoFactorDisable.mockResolvedValue(undefined);
    expect(await disableTwoFactor({ code: "123456" })).toEqual({ ok: true, status: { enabled: false, confirmed_at: null, backup_codes_remaining: 0 } });
    expect(await disableTwoFactor({ backup_code: "abcd-2345" })).toMatchObject({ ok: true });
    expect(twoFactorDisable).toHaveBeenNthCalledWith(1, { code: "123456" }, { accessToken: "a" });
    expect(twoFactorDisable).toHaveBeenNthCalledWith(2, { backup_code: "abcd-2345" }, { accessToken: "a" });
  });

  it("words a wrong backup code as such", async () => {
    twoFactorDisable.mockRejectedValue(wrong());
    expect(await disableTwoFactor({ backup_code: "abcd-2345" })).toMatchObject({ ok: false, error: expect.stringMatching(/^That backup code/) });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects malformed proofs", async () => {
    for (const bad of [null, {}, { code: "12" }, { backup_code: "abcd" }, { backup_code: 1 }]) {
      expect(await disableTwoFactor(bad as never)).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(twoFactorDisable).not.toHaveBeenCalled();
  });
});

describe("regenerateBackupCodes", () => {
  it("answers the new codes and status", async () => {
    twoFactorRegenerate.mockResolvedValue({ backup_codes: codes });
    twoFactorStatus.mockResolvedValue(on);
    expect(await regenerateBackupCodes("654321")).toEqual({ ok: true, backupCodes: codes, status: on });
    expect(twoFactorRegenerate).toHaveBeenCalledWith({ code: "654321" }, { accessToken: "a" });
  });

  it("turns not_enabled into a sentence", async () => {
    twoFactorRegenerate.mockRejectedValue(new ApiError({ status: 409, code: "not_enabled" }));
    expect(await regenerateBackupCodes("654321")).toMatchObject({ ok: false, code: "not_enabled", error: expect.stringMatching(/already off/) });
  });
});
