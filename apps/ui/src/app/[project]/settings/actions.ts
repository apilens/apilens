"use server";

// Server Actions of project settings → API keys (#350): create and revoke. Each one re-checks
// its input (a Server Action is a public POST endpoint), calls the API as the signed-in user and
// answers a sentence to show, never a raw error. Authorization is the API's: `api_keys.create`
// and `api_keys.revoke` (owners, admins and members).
import { apiKeysError, checkExpiresAt, checkKeyName, checkScopes, isKeyId, isProjectSlug } from "@/lib/api-keys";
import { type ApiKey, type CreatedApiKey, identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type CreateApiKeyResult = { ok: true; key: CreatedApiKey } | { ok: false; error: string; code?: string };
export type RevokeApiKeyResult = { ok: true; key: ApiKey | null } | { ok: false; error: string; code?: string };

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
  /** RFC 3339; omitted for a key that never expires. */
  expiresAt?: string;
}

function failed(err: unknown): { ok: false; error: string; code: string } {
  if (!isApiError(err)) throw err;
  return { ok: false, error: apiKeysError(err.code), code: err.code };
}

/** Creates a key on `project`. The raw key is in the answer and nowhere else, ever. */
export async function createApiKey(project: string, input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  if (!isProjectSlug(project)) return { ok: false, error: apiKeysError("not_found"), code: "not_found" };
  const name = checkKeyName(typeof input?.name === "string" ? input.name : "");
  if (!name.ok) return { ok: false, error: name.error };
  const scopes = checkScopes(input?.scopes);
  if (!scopes.ok) return { ok: false, error: scopes.error };
  const expiry = checkExpiresAt(input?.expiresAt);
  if (!expiry.ok) return { ok: false, error: expiry.error };
  const body = { name: name.name, scopes: scopes.scopes, ...(expiry.expiresAt ? { expires_at: expiry.expiresAt } : {}) };
  return withActionSession(async (session) => {
    try {
      const key = await session.call((o) => identity().createApiKey(project, body, o));
      return { ok: true, key };
    } catch (err) {
      return failed(err);
    }
  });
}

/**
 * Revokes key `id` of `project` and answers it as listed now (null when the list no longer has
 * it). Revoking a revoked key changes nothing.
 */
export async function revokeApiKey(project: string, id: string): Promise<RevokeApiKeyResult> {
  if (!isProjectSlug(project)) return { ok: false, error: apiKeysError("not_found"), code: "not_found" };
  if (!isKeyId(id)) return { ok: false, error: apiKeysError("api_key_gone"), code: "api_key_gone" };
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().revokeApiKey(project, id, o));
    } catch (err) {
      return failed(err);
    }
    // The revocation time is the server's; read the row back rather than guess it.
    try {
      const list = await session.call((o) => identity().listApiKeys(project, o));
      return { ok: true, key: list.find((k) => k.id === id) ?? null };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: true, key: null };
    }
  });
}
