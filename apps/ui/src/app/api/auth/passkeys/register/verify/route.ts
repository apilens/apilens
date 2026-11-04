// POST /api/auth/passkeys/register/verify {challenge_id, credential, name?}: finishes adding a
// passkey with the browser's attestation (Security settings, #341). Answers
// `{ok: true, next, passkey}` with the stored passkey as identity lists it.
import type { NextRequest } from "next/server";
import { fromError, optionalString, readJson, requiredObject, requiredString, success } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { MAX_PASSKEY_NAME, SECURITY_SETTINGS_PATH } from "@/lib/passkey-settings";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function POST(req: NextRequest) {
  return withSession(req, async (session) => {
    try {
      const body = await readJson(req);
      const challengeId = requiredString(body, "challenge_id", 128);
      const credential = requiredObject(body, "credential");
      const name = body.name === "" ? undefined : optionalString(body, "name", MAX_PASSKEY_NAME);
      const passkey = await session.call((o) =>
        identity().passkeyRegisterVerify({ challenge_id: challengeId, response: credential, ...(name ? { name } : {}) }, o),
      );
      return success(SECURITY_SETTINGS_PATH, { passkey });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
