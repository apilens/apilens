// POST /api/auth/email/verify-link {token, remember?, next?}: signs in with the emailed magic link.
// Sets the session cookie and answers `{ok: true, next}`, or `{ok: false, code: "2fa_required"}`.
import type { NextRequest } from "next/server";
import {
  callContext,
  finishSignIn,
  fromError,
  optionalBoolean,
  readJson,
  requestedNext,
  requiredString,
} from "@/lib/auth-routes";
import { identity } from "@/lib/identity";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const token = requiredString(body, "token", 2048);
    const remember = optionalBoolean(body, "remember");
    const result = await identity().emailVerifyLink({ token, remember }, callContext(req));
    return await finishSignIn(result, remember, requestedNext(body));
  } catch (err) {
    return fromError(err);
  }
}
