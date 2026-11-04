// Encrypted session cookie, Node runtime (`node:crypto`): Route Handlers,
// Server Actions and Server Components.
//
// `session-edge.ts` is the Web Crypto twin for the edge runtime. Keep the two
// in lock-step: the wire format lives in `session-format.ts`, and
// `session.vectors.json` is checked against both by `session.test.ts`.
import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "./env";
import {
  IV_LENGTH,
  KEY_LENGTH,
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

const keys = new Map<string, Buffer>();

function deriveKey(secret: string, version: number): Buffer {
  const id = `${version}\u0000${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, new Uint8Array(0), hkdfInfo(version), KEY_LENGTH));
    keys.set(id, key);
  }
  return key;
}

/** Deterministic seal with a caller-supplied IV. Test vectors only: never reuse an IV. */
export function sealWithIv(payload: SessionPayload, secret: string, iv: Uint8Array): string {
  if (iv.length !== IV_LENGTH) throw new RangeError(`seal: IV must be ${IV_LENGTH} bytes`);
  const plaintext = encodePayload(payload);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, SESSION_VERSION), iv, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(Uint8Array.of(SESSION_VERSION));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return packEnvelope(SESSION_VERSION, iv, ciphertext);
}

/** Encrypts a session into a cookie value. Throws only on an invalid payload. */
export async function seal(payload: SessionPayload, secret: string = env().sessionSecret): Promise<string> {
  return sealWithIv(payload, secret, randomBytes(IV_LENGTH));
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
    const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, version), iv, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(Uint8Array.of(version));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    return decodePayload(plaintext);
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
