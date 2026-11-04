// Browser side of `POST /api/auth/logout` (#309): revokes the session, then says where to go.
// Client-safe: no server imports.

/** Where a signed-out browser lands; mirrors `SIGNED_OUT_PATH` in auth-routes (server-only). */
export const SIGNED_OUT_PATH = "/sign-in?reason=signed_out";

const ENDPOINT = "/api/auth/logout";

/**
 * Signs out and returns the path to navigate to. Never throws: the Route Handler clears the cookie
 * whatever identity answers, and a transport failure still lands on the sign-in page.
 */
export async function signOut(fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetcher(ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    const body: unknown = await res.json().catch(() => null);
    const next = body && typeof body === "object" ? (body as Record<string, unknown>).next : undefined;
    // Only follow a same-origin sign-in path; anything else falls back to the known target.
    if (res.ok && typeof next === "string" && /^\/sign-in(\?|$)/.test(next)) return next;
  } catch {
    // Offline or identity unreachable: still leave the signed-in UI.
  }
  return SIGNED_OUT_PATH;
}
