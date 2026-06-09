/**
 * Edge-safe session-cookie verification for middleware.
 *
 * `session.ts` decrypts the cookie with Node's `crypto` (Server Components /
 * route handlers). Middleware runs on the edge runtime where `node:crypto`
 * isn't available, so we re-verify here with the Web Crypto API.
 *
 * Both sides MUST agree on the cookie shape, or the auth gate loops:
 *   base64url( iv[12] || authTag[16] || ciphertext )  — AES-256-GCM,
 *   key = SHA-256(SESSION_SECRET).
 * Keep this in lock-step with `setSession`/`getSession` in `session.ts`.
 */

const ALGORITHM = "AES-GCM";

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is required");
  }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: ALGORITHM }, false, ["decrypt"]);
}

/**
 * Returns true only when the cookie decrypts AND carries a usable session.
 * Anything else (missing, malformed, wrong secret, tampered) → false, so the
 * caller can treat it as logged-out and clear the stale cookie.
 */
export async function verifySessionCookie(value: string | undefined): Promise<boolean> {
  if (!value) return false;
  try {
    const raw = base64urlToBytes(value);
    if (raw.length <= 28) return false; // need iv(12) + tag(16) + at least 1 byte

    // Copy into fresh ArrayBuffer-backed arrays so they satisfy BufferSource.
    const iv = new Uint8Array(raw.subarray(0, 12));
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);

    // Web Crypto expects ciphertext concatenated with the auth tag.
    const data = new Uint8Array(ciphertext.length + tag.length);
    data.set(ciphertext, 0);
    data.set(tag, ciphertext.length);

    const key = await getKey();
    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, data);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    return typeof parsed?.accessToken === "string" && parsed.accessToken.length > 0;
  } catch {
    return false;
  }
}
