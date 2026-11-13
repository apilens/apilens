// POST /api/auth/reauth/options {send_email_code?, next?}: how the signed-in user can confirm who
// they are again after a sensitive action answered `reauth_required` (#803). Answers
// `{ok: true, next, methods, passkey?, sso_url?, email_code_sent, retry_after?}` from identity's
// `POST /auth/reauth/options`; `send_email_code: true` emails a code now. `next` is where an SSO
// re-authentication returns to.
import type { NextRequest } from "next/server";
import { fromError, optionalBoolean, readJson, success } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { safeNext } from "@/lib/safe-next";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function POST(req: NextRequest) {
  return withSession(req, async (session) => {
    try {
      const body = await readJson(req);
      const sendEmailCode = optionalBoolean(body, "send_email_code");
      const next = safeNext(body.next);
      const options = await session.call((o) =>
        identity().reauthOptions({ ...(sendEmailCode ? { send_email_code: true } : {}), next }, o),
      );
      return success(next, {
        methods: options.methods,
        ...(options.passkey ? { passkey: options.passkey } : {}),
        ...(options.sso_url ? { sso_url: options.sso_url } : {}),
        email_code_sent: options.email_code_sent === true,
        ...(options.retry_after ? { retry_after: options.retry_after } : {}),
      });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
