// POST /api/auth/passkeys/register/options {}: starts adding a passkey to the signed-in user
// (Security settings, #341). Answers `{ok: true, next, challenge_id, options}`; `options` feeds
// `navigator.credentials.create()` and `challenge_id` goes back with the attestation to
// `/api/auth/passkeys/register/verify`.
import type { NextRequest } from "next/server";
import { fromError, readJson, success } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { SECURITY_SETTINGS_PATH } from "@/lib/passkey-settings";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function POST(req: NextRequest) {
  return withSession(req, async (session) => {
    try {
      await readJson(req);
      const started = await session.call((o) => identity().passkeyRegisterOptions(o));
      return success(SECURITY_SETTINGS_PATH, { challenge_id: started.challenge_id, options: started.options });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
