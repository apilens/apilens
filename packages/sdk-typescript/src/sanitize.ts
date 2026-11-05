/**
 * Header redaction and serialization.
 *
 * Port of the Python SDK's `apilens/client/_sanitize.py` (`SENSITIVE_HEADERS`,
 * `DEFAULT_MASK_HEADER_PATTERNS`, `serialize_headers`) so `request_headers` /
 * `response_headers` use the same wire format across SDKs: a compact JSON
 * object of lower-cased names, secrets as `[redacted]`, capped at 8 KB by
 * dropping the longest values first.
 */

export const REDACTED = "[redacted]";

/** Header names whose VALUES must never leave the app (case-insensitive). */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-amz-security-token",
  "x-csrf-token",
]);

/**
 * Built-in header-name patterns that are ALWAYS masked (Apitally parity),
 * matched case-insensitively anywhere in the name.
 */
export const DEFAULT_MASK_HEADER_PATTERNS: readonly string[] = [
  "auth",
  "api.?key",
  "secret",
  "token",
  "cookie",
];

export const MAX_HEADER_BYTES = 8192;

const DEFAULT_HEADER_RE = new RegExp(
  DEFAULT_MASK_HEADER_PATTERNS.map((p) => `(?:${p})`).join("|"),
  "i",
);

export type HeaderValue = string | number | readonly string[] | undefined | null;
export type HeaderMap = Record<string, HeaderValue>;

export type SerializeHeadersOptions = {
  maxBytes?: number;
};

function headerValueToString(value: Exclude<HeaderValue, undefined | null>): string {
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).join(", ");
  }
  return String(value);
}

/** Python `len(str)` counts code points, not UTF-16 units. */
function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) {
    n += 1;
  }
  return n;
}

function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name) || DEFAULT_HEADER_RE.test(name);
}

/**
 * Serialize a header map to a compact JSON string, redacting secrets.
 *
 * Returns `""` when there are no headers. Names are lower-cased; values of
 * {@link SENSITIVE_HEADERS} and of names matching
 * {@link DEFAULT_MASK_HEADER_PATTERNS} become `[redacted]`. Multi-value
 * headers (Node arrays) are joined with `", "`. When the JSON exceeds
 * `maxBytes` (UTF-8), keys are dropped longest-value-first until it fits.
 */
export function serializeHeaders(
  headers: HeaderMap | null | undefined,
  options: SerializeHeadersOptions = {},
): string {
  if (!headers) {
    return "";
  }
  const maxBytes = options.maxBytes ?? MAX_HEADER_BYTES;
  const safe = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    const name = (key || "").toLowerCase();
    if (!name || value === undefined || value === null) {
      continue;
    }
    safe.set(name, isSensitiveHeader(name) ? REDACTED : headerValueToString(value));
  }
  if (safe.size === 0) {
    return "";
  }

  const encode = (): string => JSON.stringify(Object.fromEntries(safe));
  let blob = encode();
  if (Buffer.byteLength(blob, "utf8") > maxBytes) {
    // Drop keys (longest values first; ties keep insertion order) until it fits.
    const byLength = [...safe.entries()].sort(
      (a, b) => codePointLength(b[1]) - codePointLength(a[1]),
    );
    for (const [name] of byLength) {
      safe.delete(name);
      blob = encode();
      if (Buffer.byteLength(blob, "utf8") <= maxBytes) {
        break;
      }
    }
  }
  return blob;
}
