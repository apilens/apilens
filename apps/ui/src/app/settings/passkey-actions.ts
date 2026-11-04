"use server";

// Server Actions of Security → Passkeys (#341): rename and remove. Each one re-checks its input
// (a Server Action is a public POST endpoint), calls identity as the signed-in user and answers
// a sentence to show, never a raw error. Adding a passkey goes through the Route Handlers under
// `/api/auth/passkeys/register/*` instead: the WebAuthn ceremony runs in the browser between them.
import { type Passkey, identity, isApiError } from "@/lib/identity";
import { checkPasskeyName, isPasskeyId, passkeySettingsError } from "@/lib/passkey-settings";
import { withActionSession } from "@/lib/server-session";

export type RenamePasskeyResult = { ok: true; passkey: Passkey } | { ok: false; error: string; code?: string };
export type RemovePasskeyResult = { ok: true } | { ok: false; error: string; code?: string };

function failed(err: unknown): { ok: false; error: string; code: string } {
  if (!isApiError(err)) throw err;
  return { ok: false, error: passkeySettingsError(err.code) ?? passkeySettingsError("")!, code: err.code };
}

/** Renames one of the signed-in user's passkeys. */
export async function renamePasskey(id: string, name: string): Promise<RenamePasskeyResult> {
  if (!isPasskeyId(id)) return { ok: false, error: passkeySettingsError("passkey_gone")!, code: "passkey_gone" };
  const checked = checkPasskeyName(typeof name === "string" ? name : "");
  if (!checked.ok) return { ok: false, error: checked.error };
  return withActionSession(async (session) => {
    try {
      const passkey = await session.call((o) => identity().renameMyPasskey(id, { name: checked.name }, o));
      return { ok: true, passkey };
    } catch (err) {
      return failed(err);
    }
  });
}

/** Removes one of the signed-in user's passkeys. One that is already gone counts as removed. */
export async function removePasskey(id: string): Promise<RemovePasskeyResult> {
  if (!isPasskeyId(id)) return { ok: true };
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().deleteMyPasskey(id, o));
      return { ok: true };
    } catch (err) {
      if (isApiError(err) && err.code === "passkey_gone") return { ok: true };
      return failed(err);
    }
  });
}
