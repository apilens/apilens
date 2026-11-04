// POST /api/auth/email/verify {email, code, remember?, next?}: signs in with the emailed code.
// Sets the session cookie and answers `{ok: true, next}`, or `{ok: false, code: "2fa_required"}`.
import type { NextRequest } from "next/server";
import {
  callContext,
  email,
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
    const address = email(body);
    const code = requiredString(body, "code", 64);
    const remember = optionalBoolean(body, "remember");
    const result = await identity().emailVerify({ email: address, code, remember }, callContext(req));
    return await finishSignIn(result, remember, requestedNext(body));
  } catch (err) {
    return fromError(err);
  }
}
