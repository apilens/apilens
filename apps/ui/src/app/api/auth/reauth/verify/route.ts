// POST /api/auth/reauth/verify {method: "totp" | "email", code} | {method: "passkey",
// challenge_id, credential}: confirms who the signed-in user is (#803). On success identity
// answers a new access token whose `auth_time` is now; it replaces the one in the session cookie
// (the refresh token does not change) and the answer is `{ok: true, next, auth_time}`. The caller
// then retries the action that asked for it.
import type { NextRequest } from "next/server";
import { ROUTE_ERROR_CODES, failure, fromError, readJson, requiredObject, requiredString, success } from "@/lib/auth-routes";
import { type ReauthVerifyRequest, identity } from "@/lib/identity";
import { safeNext } from "@/lib/safe-next";
import { isSessionExpired, withSession } from "@/lib/server-session";

const METHODS = new Set(["passkey", "totp", "email"]);

export async function POST(req: NextRequest) {
  return withSession(req, async (session) => {
    try {
      const body = await readJson(req);
      const method = body.method;
      if (typeof method !== "string" || !METHODS.has(method)) return failure(422, ROUTE_ERROR_CODES.validation);
      const verify: ReauthVerifyRequest =
        method === "passkey"
          ? { method, challenge_id: requiredString(body, "challenge_id", 128), response: requiredObject(body, "credential") }
          : { method: method as "totp" | "email", code: requiredString(body, "code", 64) };
      const verified = await session.call((o) => identity().reauthVerify(verify, o));
      await session.replaceAccess(verified.access_token, verified.expires_in);
      return success(safeNext(body.next), { auth_time: verified.auth_time });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
