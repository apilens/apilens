// POST /api/auth/logout: revokes the refresh token at identity and clears the session cookie.
// Always answers `{ok: true, next: "/sign-in?reason=signed_out"}` and clears the cookie, even when identity is
// unreachable or the session was already gone: signing out must never leave the browser signed in.
import type { NextRequest } from "next/server";
import {
  SIGNED_OUT_PATH,
  callContext,
  checkRequest,
  clearPreAuthCookie,
  clearSessionCookie,
  fromError,
  success,
} from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { SESSION_COOKIE_NAME, open } from "@/lib/session";

export async function POST(req: NextRequest) {
  try {
    checkRequest(req);
  } catch (err) {
    return fromError(err);
  }
  const session = await open(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (session) {
    try {
      await identity().logout(
        { refresh_token: session.refresh },
        { ...callContext(req), accessToken: session.access },
      );
    } catch (err) {
      // The cookie is cleared regardless; the refresh token expires on its own.
      console.warn("identity logout failed", err instanceof Error ? err.message : err);
    }
  }
  const res = success(SIGNED_OUT_PATH);
  clearSessionCookie(res);
  clearPreAuthCookie(res);
  return res;
}
