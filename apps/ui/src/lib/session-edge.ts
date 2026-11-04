// Encrypted session cookie, Web Crypto (`crypto.subtle`) for the edge runtime
// and the proxy (middleware). No Node APIs (no Buffer, no node:crypto).
//
// Twin of `session.ts`: keep the two in lock-step. The wire format lives in
// `session-format.ts`, and `session.vectors.json` is checked against both by
// `session.test.ts`.
import "server-only";
import { env } from "./env";
import {
  IV_LENGTH,
  SESSION_VERSION,
  TAG_LENGTH,
  type SessionCookieOptions,
  type SessionPayload,
  decodePayload,
  encodePayload,
  hkdfInfo,
  packEnvelope,
  sessionCookieOptions as cookieOptionsFor,
  unpackEnvelope,
} from "./session-format";

export { SESSION_COOKIE_NAME } from "./session-format";
export type { SessionCookieOptions, SessionPayload } from "./session-format";

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function deriveKey(secret: string, version: number): Promise<CryptoKey> {
  const id = `${version}\u0000${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((ikm) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(hkdfInfo(version)) },
          ikm,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    keys.set(id, key);
  }
  return key;
}

/** Deterministic seal with a caller-supplied IV. Test vectors only: never reuse an IV. */
export async function sealWithIv(payload: SessionPayload, secret: string, iv: Uint8Array): Promise<string> {
  if (iv.length !== IV_LENGTH) throw new RangeError(`seal: IV must be ${IV_LENGTH} bytes`);
  const plaintext = encodePayload(payload);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv),
      additionalData: Uint8Array.of(SESSION_VERSION),
      tagLength: TAG_LENGTH * 8,
    },
    await deriveKey(secret, SESSION_VERSION),
    new Uint8Array(plaintext),
  );
  return packEnvelope(SESSION_VERSION, iv, new Uint8Array(ciphertext));
}

/** Encrypts a session into a cookie value. Throws only on an invalid payload. */
export async function seal(payload: SessionPayload, secret: string = env().sessionSecret): Promise<string> {
  return sealWithIv(payload, secret, crypto.getRandomValues(new Uint8Array(IV_LENGTH)));
}

/**
 * Decrypts a cookie value. Returns null for anything missing, tampered, of an
 * unknown version or malformed; never throws on cookie input (a missing
 * SESSION_SECRET still throws, so misconfiguration is not mistaken for "signed out").
 */
export async function open(
  cookie: string | null | undefined,
  secret: string = env().sessionSecret,
): Promise<SessionPayload | null> {
  try {
    const envelope = unpackEnvelope(cookie);
    if (!envelope) return null;
    const { version, iv, ciphertext } = envelope;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(iv),
        additionalData: Uint8Array.of(version),
        tagLength: TAG_LENGTH * 8,
      },
      await deriveKey(secret, version),
      new Uint8Array(ciphertext),
    );
    return decodePayload(new Uint8Array(plaintext));
  } catch {
    return null;
  }
}

/** Set-Cookie attributes for a session; `secure` when APILENS_PUBLIC_URL is https. */
export function sessionCookieOptions(
  remember: boolean,
  publicUrl: string = env().publicUrl,
): SessionCookieOptions {
  return cookieOptionsFor(remember, publicUrl);
}
