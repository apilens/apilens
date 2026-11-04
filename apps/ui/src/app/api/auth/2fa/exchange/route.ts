// POST /api/auth/2fa/exchange {code} | {backup_code}: completes a sign-in that answered
// `2fa_required`. The pre-auth token comes from its httpOnly cookie, never from the browser's
// JSON. Sets the session cookie and answers `{ok: true, next}`.
import type { NextRequest } from "next/server";
import {
  ROUTE_ERROR_CODES,
  callContext,
  failure,
  fromError,
  optionalString,
  readJson,
  readPreAuth,
  signedIn,
} from "@/lib/auth-routes";
import { type TwoFactorExchangeRequest, identity } from "@/lib/identity";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const code = optionalString(body, "code", 16);
    const backupCode = optionalString(body, "backup_code", 64);
    if ((code === undefined) === (backupCode === undefined)) {
      return failure(422, ROUTE_ERROR_CODES.validation);
    }
    const pre = readPreAuth(req);
    if (!pre) return failure(401, ROUTE_ERROR_CODES.preAuthMissing);
    const exchange: TwoFactorExchangeRequest =
      code !== undefined
        ? { pre_auth_token: pre.token, code }
        : { pre_auth_token: pre.token, backup_code: backupCode as string };
    const bundle = await identity().twoFactorExchange(exchange, callContext(req));
    return await signedIn(bundle, pre.remember, pre.next);
  } catch (err) {
    return fromError(err);
  }
}
