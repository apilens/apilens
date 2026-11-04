"use server";

// Server Actions of Security → Two-factor (#342). Each one re-checks its input (a Server Action
// is a public POST endpoint), calls identity as the signed-in user and answers a sentence to
// show, never a raw error. Backup codes come back in the answer once and are never stored here.
import { revalidatePath } from "next/cache";
import { type ApiError, type IdentityClient, type TwoFactorStatus, identity, isApiError } from "@/lib/identity";
import { type ServerSession, withActionSession } from "@/lib/server-session";
import { isTotp, twoFactorSettingsError } from "@/lib/two-factor-settings";
import { isBackupCode } from "@/lib/two-factor";

export type TwoFactorFailure = { ok: false; error: string; code: string };
export type EnrollResult = { ok: true; secret: string; otpauthUri: string } | TwoFactorFailure;
export type CodesResult = { ok: true; backupCodes: string[]; status: TwoFactorStatus } | TwoFactorFailure;
export type DisableResult = { ok: true; status: TwoFactorStatus } | TwoFactorFailure;

const SECURITY_PATH = "/settings/security";
const OFF: TwoFactorStatus = { enabled: false, confirmed_at: null, backup_codes_remaining: 0 };

/**
 * A wrong code answers 401 `invalid_totp`. Re-thrown as something other than an ApiError so
 * `session.call` does not mistake it for an expired access token and refresh to retry it.
 */
class WrongCode extends Error {
  constructor(readonly err: ApiError) {
    super(err.message);
  }
}

type Authed = Parameters<Parameters<ServerSession["call"]>[0]>[0];

async function run<T>(fn: (api: IdentityClient, o: Authed) => Promise<T>): Promise<T | TwoFactorFailure> {
  return withActionSession(async (session) => {
    try {
      return await session.call(async (o) => {
        try {
          return await fn(identity(), o);
        } catch (err) {
          if (isApiError(err) && err.code === "invalid_totp") throw new WrongCode(err);
          throw err;
        }
      });
    } catch (err) {
      const api = err instanceof WrongCode ? err.err : err;
      if (!isApiError(api)) throw err;
      return { ok: false, error: twoFactorSettingsError(api.code), code: api.code };
    }
  });
}

function invalid(backup = false): TwoFactorFailure {
  return { ok: false, error: twoFactorSettingsError("invalid_request", backup), code: "invalid_request" };
}

const failed = (r: unknown): r is TwoFactorFailure => typeof r === "object" && r !== null && (r as TwoFactorFailure).ok === false;

/** Starts turning two-factor on: a fresh pending secret and its `otpauth://` URI for the QR code. */
export async function startTwoFactor(): Promise<EnrollResult> {
  const res = await run((api, o) => api.twoFactorEnable(o));
  if (failed(res)) return res;
  return { ok: true, secret: res.secret, otpauthUri: res.otpauth_uri };
}

/**
 * Fresh codes plus the status they leave behind. The codes are what matters (they are shown
 * once), so a status read that fails falls back to what the codes imply.
 */
async function withStatus(api: IdentityClient, o: Authed, codes: string[]): Promise<{ codes: string[]; status: TwoFactorStatus }> {
  const implied: TwoFactorStatus = { enabled: true, confirmed_at: null, backup_codes_remaining: codes.length };
  const status = await api.twoFactorStatus(o).catch(() => implied);
  return { codes, status };
}

/** Confirms the pending secret with a code from the app; answers the backup codes, shown once. */
export async function confirmTwoFactor(code: string): Promise<CodesResult> {
  if (typeof code !== "string" || !isTotp(code)) return invalid();
  const res = await run(async (api, o) => withStatus(api, o, (await api.twoFactorVerify({ code }, o)).backup_codes));
  if (failed(res)) return res;
  revalidatePath(SECURITY_PATH);
  return { ok: true, backupCodes: res.codes, status: res.status };
}

/** Turns two-factor off with a code from the app or an unused backup code. */
export async function disableTwoFactor(proof: { code: string } | { backup_code: string }): Promise<DisableResult> {
  if (typeof proof !== "object" || proof === null) return invalid();
  const backup = "backup_code" in proof;
  const value = backup ? proof.backup_code : (proof as { code: unknown }).code;
  if (typeof value !== "string" || !(backup ? isBackupCode(value) : isTotp(value))) return invalid(backup);
  const res = await run((api, o) => api.twoFactorDisable(backup ? { backup_code: value } : { code: value }, o));
  if (failed(res)) return { ...res, error: twoFactorSettingsError(res.code, backup) };
  revalidatePath(SECURITY_PATH);
  return { ok: true, status: OFF };
}

/** Replaces every backup code with ten new ones (old ones stop working); needs a code from the app. */
export async function regenerateBackupCodes(code: string): Promise<CodesResult> {
  if (typeof code !== "string" || !isTotp(code)) return invalid();
  const res = await run(async (api, o) => withStatus(api, o, (await api.twoFactorRegenerate({ code }, o)).backup_codes));
  if (failed(res)) return res;
  revalidatePath(SECURITY_PATH);
  return { ok: true, backupCodes: res.codes, status: res.status };
}
