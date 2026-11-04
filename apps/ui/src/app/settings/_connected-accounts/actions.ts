"use server";

// Server Actions of Settings → Connected accounts (#344). Each re-checks its input (a Server
// Action is a public POST endpoint) and calls identity as the signed-in user; failures answer a
// sentence to show, never a raw error.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CONNECTED_ACCOUNTS_PATH, connectedAccountsError, isOAuthProvider } from "@/lib/connected-accounts";
import { identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type ConnectedActionResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failed(err: unknown): ConnectedActionResult {
  if (!isApiError(err)) throw err;
  return { ok: false, error: connectedAccountsError(err.code) };
}

/**
 * Starts connecting a Google or GitHub account: identity's start endpoint (`intent=link`) needs
 * the session, so it is called from here and the browser is sent on to the provider. Identity
 * brings it back to this page afterwards. Answers only when the flow could not start.
 */
export async function connectAccount(provider: string): Promise<ConnectedActionResult> {
  if (!isOAuthProvider(provider)) return { ok: false, error: connectedAccountsError("not_found") };
  const location = await withActionSession(async (session): Promise<ConnectedActionResult | string> => {
    try {
      return await session.call((o) => identity().oauthLinkStart(provider, CONNECTED_ACCOUNTS_PATH, o));
    } catch (err) {
      return failed(err);
    }
  });
  if (typeof location !== "string") return location;
  if (!/^https?:\/\//i.test(location)) return { ok: false, error: connectedAccountsError("server_error") };
  redirect(location);
}

/** Disconnects one of the user's accounts. One that is already gone counts as disconnected. */
export async function disconnectAccount(id: string): Promise<ConnectedActionResult> {
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, error: connectedAccountsError("oauth_identity_gone") };
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().deleteIdentity(id, o));
    } catch (err) {
      if (!(isApiError(err) && err.code === "oauth_identity_gone")) return failed(err);
    }
    revalidatePath(CONNECTED_ACCOUNTS_PATH);
    return { ok: true };
  });
}
