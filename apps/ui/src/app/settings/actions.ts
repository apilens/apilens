"use server";

// Server Actions of the account settings (#343, Sessions). Each one re-checks its input (a Server
// Action is a public POST endpoint), calls identity as the signed-in user, revalidates the
// section so the table re-renders from the server, and answers a sentence to show, never a raw
// error.
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";
import { SESSION_COOKIE_NAME } from "@/lib/session";
import { SESSIONS_PATH, sessionsError } from "@/lib/sessions";
import { SIGNED_OUT_PATH } from "@/lib/sign-out";

export type SessionsActionResult = { ok: true; revoked: number } | { ok: false; error: string; code?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failed(err: unknown): SessionsActionResult {
  if (!isApiError(err)) throw err;
  return { ok: false, error: sessionsError(err.code), code: err.code };
}

/**
 * Ends one session. Whether it is the current one is decided here from the server's list, not
 * by the browser: revoking the current session also clears the cookie and sends the browser to
 * `/sign-in?reason=signed_out`. Any other session answers `{ok: true}` and the table refreshes.
 */
export async function revokeSession(id: string): Promise<SessionsActionResult> {
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, error: sessionsError("invalid_request"), code: "invalid_request" };
  const result = await withActionSession(async (session): Promise<SessionsActionResult | "signed_out"> => {
    try {
      const { sessions } = await session.call((o) => identity().listSessions(o));
      const current = sessions.some((s) => s.id === id && s.current);
      // Unknown or already ended answers 204 too: either way it is gone.
      await session.call((o) => identity().revokeSession(id, o));
      if (current) return "signed_out";
    } catch (err) {
      return failed(err);
    }
    revalidatePath(SESSIONS_PATH);
    return { ok: true, revoked: 1 };
  });
  if (result !== "signed_out") return result;
  (await cookies()).delete(SESSION_COOKIE_NAME);
  redirect(SIGNED_OUT_PATH);
}

/** Ends every session except the current one. */
export async function signOutOtherSessions(): Promise<SessionsActionResult> {
  return withActionSession(async (session) => {
    try {
      const { revoked } = await session.call((o) => identity().revokeOtherSessions(o));
      revalidatePath(SESSIONS_PATH);
      return { ok: true, revoked };
    } catch (err) {
      return failed(err);
    }
  });
}
