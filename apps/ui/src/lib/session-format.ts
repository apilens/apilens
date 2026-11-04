// Runtime-neutral pieces of the session cookie, shared by the Node
// (`session.ts`) and Web Crypto (`session-edge.ts`) implementations so the two
// cannot drift: wire layout, payload validation, base64url and cookie options.
// No crypto and no environment access here.
//
// Cookie value = base64url( version (1 byte) | IV (12 bytes) | AES-256-GCM ciphertext+tag )
//
// - base64url, never standard base64: Next URL-encodes `+`, `/` and `=` in
//   Set-Cookie, which breaks decryption on the way back in.
// - The version byte is authenticated as GCM additional data and selects the
//   key-derivation label, so a future format or key rotation can be rolled out
//   by bumping it while old cookies fail closed.
// - The AES key is HKDF-SHA256(SESSION_SECRET, salt = "", info = HKDF_INFO).

export const SESSION_COOKIE_NAME = "apilens_session";

/** Current payload format. Bump (and add a branch in open) to rotate. */
export const SESSION_VERSION = 1;

export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;
export const KEY_LENGTH = 32;
/** Browsers cap a cookie at ~4 KiB; anything longer is not ours. */
export const MAX_COOKIE_LENGTH = 4096;

/** Max-age with "remember me" checked: 30 days. */
export const REMEMBER_MAX_AGE = 30 * 24 * 60 * 60;
/** Max-age without "remember me": 24 hours. */
export const SESSION_MAX_AGE = 24 * 60 * 60;

export interface SessionPayload {
  /** Access token (short-lived JWT). */
  access: string;
  /** Opaque refresh token. */
  refresh: string;
  /** Access-token expiry, Unix seconds. */
  exp: number;
  /** "Remember me": selects the cookie max-age. */
  remember: boolean;
  /** User id. */
  uid: string;
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

/** HKDF info label for a payload version. */
export function hkdfInfo(version: number): string {
  return `apilens_session/v${version}`;
}

/** Cookie attributes for a session. `secure` follows the scheme of the public URL. */
export function sessionCookieOptions(remember: boolean, publicUrl: string): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: publicUrl.toLowerCase().startsWith("https:"),
    path: "/",
    maxAge: remember ? REMEMBER_MAX_AGE : SESSION_MAX_AGE,
  };
}

/** Strict shape check; returns a copy holding only the known fields, or null. */
export function toSessionPayload(value: unknown): SessionPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.access !== "string" || v.access === "") return null;
  if (typeof v.refresh !== "string" || v.refresh === "") return null;
  if (typeof v.exp !== "number" || !Number.isSafeInteger(v.exp) || v.exp < 0) return null;
  if (typeof v.remember !== "boolean") return null;
  if (typeof v.uid !== "string" || v.uid === "") return null;
  return { access: v.access, refresh: v.refresh, exp: v.exp, remember: v.remember, uid: v.uid };
}

/** Serialises a payload; throws on an invalid one (a programming error at seal time). */
export function encodePayload(payload: SessionPayload): Uint8Array {
  const clean = toSessionPayload(payload);
  if (!clean) throw new TypeError("seal: invalid session payload");
  return new TextEncoder().encode(JSON.stringify(clean));
}

/** Parses decrypted plaintext; null on anything malformed. */
export function decodePayload(plaintext: Uint8Array): SessionPayload | null {
  try {
    return toSessionPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
  } catch {
    return null;
  }
}

/** Joins version | iv | ciphertext into the cookie value. */
export function packEnvelope(version: number, iv: Uint8Array, ciphertext: Uint8Array): string {
  const out = new Uint8Array(1 + iv.length + ciphertext.length);
  out[0] = version;
  out.set(iv, 1);
  out.set(ciphertext, 1 + iv.length);
  return toBase64Url(out);
}

export interface Envelope {
  version: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** Splits a cookie value; null if it is not a well-formed envelope of a known version. */
export function unpackEnvelope(cookie: unknown): Envelope | null {
  if (typeof cookie !== "string" || cookie.length > MAX_COOKIE_LENGTH) return null;
  const bytes = fromBase64Url(cookie);
  if (!bytes || bytes.length < 1 + IV_LENGTH + TAG_LENGTH) return null;
  const version = bytes[0];
  if (version !== SESSION_VERSION) return null;
  return {
    version,
    iv: bytes.subarray(1, 1 + IV_LENGTH),
    ciphertext: bytes.subarray(1 + IV_LENGTH),
  };
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict unpadded base64url decode; null on any character outside the alphabet. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    // Reject non-canonical encodings (stray low bits in the final character).
    return toBase64Url(out) === text ? out : null;
  } catch {
    return null;
  }
}
