// Sanitises a post-auth `next` redirect target. `next` arrives from query strings and emailed
// links, so anything that could send the user off this origin (an open redirect) is replaced by
// the fallback. Used by the auth gate, Route Handlers, /verify, /auth/callback and /invite/*.

/** Longest `next` value accepted; anything longer falls back. */
export const SAFE_NEXT_MAX_LENGTH = 512;

/**
 * Returns `input` when it is a same-origin relative path, otherwise `fallback`.
 *
 * Accepted: a string of at most 512 characters that starts with exactly one `/`.
 * Rejected: `//host` (protocol-relative), any backslash (browsers treat `\` as `/`, so
 * `/\host` is `//host`), anything not starting with `/` (so no `https:` or `javascript:`
 * scheme), and ASCII control characters (browsers strip tab/CR/LF from URLs, which would
 * turn `/\t/host` into `//host`).
 */
export function safeNext(input: unknown, fallback = "/"): string {
  if (typeof input !== "string") return fallback;
  if (input.length === 0 || input.length > SAFE_NEXT_MAX_LENGTH) return fallback;
  if (input[0] !== "/" || input[1] === "/") return fallback;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 0x5c /* \ */ || code < 0x20 || code === 0x7f) return fallback;
  }
  return input;
}
