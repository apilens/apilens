// POST /api/auth/passkeys/login/verify {challenge_id, credential, remember?, next?}: finishes a
// passkey sign-in with the browser's assertion. Sets the session cookie and answers `{ok: true, next}`.
import type { NextRequest } from "next/server";
import {
  callContext,
  fromError,
  optionalBoolean,
  readJson,
  requestedNext,
  requiredObject,
  requiredString,
  signedIn,
} from "@/lib/auth-routes";
import { identity } from "@/lib/identity";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const challengeId = requiredString(body, "challenge_id", 256);
    const credential = requiredObject(body, "credential");
    const remember = optionalBoolean(body, "remember");
    const bundle = await identity().passkeyLoginVerify(
      { challenge_id: challengeId, response: credential, remember },
      callContext(req),
    );
    return await signedIn(bundle, remember, requestedNext(body));
  } catch (err) {
    return fromError(err);
  }
}
