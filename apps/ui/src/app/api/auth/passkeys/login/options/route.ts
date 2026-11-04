// POST /api/auth/passkeys/login/options {email?}: starts a passkey sign-in. Answers
// `{ok: true, next, challenge_id, options}`; `options` feeds `navigator.credentials.get()` and
// `challenge_id` goes back with the assertion to `/api/auth/passkeys/login/verify`.
import type { NextRequest } from "next/server";
import { callContext, email, fromError, readJson, success } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { SIGN_IN_PATH } from "@/lib/auth-gate";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const address = body.email === undefined || body.email === null ? undefined : email(body);
    const started = await identity().passkeyLoginOptions(
      address === undefined ? {} : { email: address },
      callContext(req),
    );
    return success(SIGN_IN_PATH, { challenge_id: started.challenge_id, options: started.options });
  } catch (err) {
    return fromError(err);
  }
}
