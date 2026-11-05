/**
 * PII redaction and header serialization.
 *
 * Port of the Python SDK's `apilens/client/_sanitize.py` (`SENSITIVE_HEADERS`,
 * the `DEFAULT_MASK_*` pattern lists, `Redactor`, `serialize_headers`) so
 * captured query strings, headers and JSON bodies are redacted identically
 * across SDKs. `request_headers` / `response_headers` share one wire format: a
 * compact JSON object of lower-cased names, secrets as `[redacted]`, capped at
 * 8 KB by dropping the longest values first.
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

/*
 * Built-in name patterns that are ALWAYS masked (Apitally parity). User
 * patterns extend these, never replace them. Each is matched
 * case-insensitively anywhere in the query parameter / header / JSON field
 * *name*.
 */

/** Built-in query-parameter name patterns. */
export const DEFAULT_MASK_QUERY_PARAMS: readonly string[] = [
  "auth",
  "api.?key",
  "secret",
  "token",
  "password",
  "pwd",
];

/** Built-in header-name patterns. */
export const DEFAULT_MASK_HEADER_PATTERNS: readonly string[] = [
  "auth",
  "api.?key",
  "secret",
  "token",
  "cookie",
];

/** Built-in JSON body field-name patterns. */
export const DEFAULT_MASK_BODY_FIELDS: readonly string[] = [
  "password",
  "pwd",
  "token",
  "secret",
  "auth",
  "card.?number",
  "ccv",
  "cvv",
  "cvc",
  "ssn",
];

export const MAX_HEADER_BYTES = 8192;

/**
 * How deep {@link Redactor.redactBody} walks nested JSON before giving up
 * (guards against adversarially deep documents).
 */
export const MAX_BODY_DEPTH = 32;

/** A user redaction pattern: a regex source string or a `RegExp` (its flags are ignored). */
export type RedactPattern = string | RegExp;

/**
 * Combine built-in and user patterns into ONE case-insensitive regex.
 *
 * Each source pattern is wrapped in its own non-capturing group so
 * alternation can't change its meaning. Every pattern is compiled on its own
 * first so a bad user regex fails loudly with a precise error.
 */
function compilePatterns(
  defaults: readonly string[],
  extra: ReadonlyArray<RedactPattern> | null | undefined,
): RegExp {
  const sources = [
    ...defaults,
    ...(extra || []).map((p) => (p instanceof RegExp ? p.source : String(p))),
  ];
  for (const source of sources) {
    new RegExp(source, "i");
  }
  return new RegExp(sources.map((p) => `(?:${p})`).join("|"), "i");
}

const DEFAULT_HEADER_RE = compilePatterns(DEFAULT_MASK_HEADER_PATTERNS, []);

export type HeaderValue = string | number | readonly string[] | undefined | null;
export type HeaderMap = Record<string, HeaderValue>;

export type SerializeHeadersOptions = {
  maxBytes?: number;
  /** Adds the app's own header patterns on top of the built-ins. */
  redactor?: Redactor;
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

function isSensitiveHeader(name: string, redactor: Redactor | undefined): boolean {
  if (SENSITIVE_HEADERS.has(name)) {
    return true;
  }
  return redactor ? redactor.headerMatches(name) : DEFAULT_HEADER_RE.test(name);
}

export type RedactorOptions = {
  /** Extra query-parameter name patterns (extend {@link DEFAULT_MASK_QUERY_PARAMS}). */
  queryParams?: ReadonlyArray<RedactPattern>;
  /** Extra header name patterns (extend {@link DEFAULT_MASK_HEADER_PATTERNS}). */
  headers?: ReadonlyArray<RedactPattern>;
  /** Extra JSON body field-name patterns (extend {@link DEFAULT_MASK_BODY_FIELDS}). */
  bodyFields?: ReadonlyArray<RedactPattern>;
};

/**
 * Python `urllib.parse.unquote` after `+` -> space: percent-decodes bytes
 * leniently (malformed escapes stay literal) and decodes UTF-8 with
 * replacement characters.
 */
function unquotePlus(value: string): string {
  const text = value.replace(/\+/g, " ");
  if (!text.includes("%")) {
    return text;
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; ) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 3;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    bytes.push(...Buffer.from(ch, "utf8"));
    i += ch.length;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Python `urllib.parse.parse_qsl(query, keep_blank_values=True)`. */
function parseQuery(query: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of query.split("&")) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    const name = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? "" : part.slice(eq + 1);
    pairs.push([unquotePlus(name), unquotePlus(value)]);
  }
  return pairs;
}

/**
 * Python `urllib.parse.quote(s, safe="[]")`: only `A-Za-z0-9_.-~` and `[]`
 * stay literal, so `[redacted]` remains readable in the request log.
 */
function quoteComponent(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%5B/g, "[")
    .replace(/%5D/g, "]");
}

/**
 * Compiled PII redaction rules for captured request data.
 *
 * Built once per middleware: the built-in `DEFAULT_MASK_*` patterns always
 * apply and the user-supplied regex lists extend them. Every pattern is
 * matched case-insensitively against the *name* of the thing being redacted
 * (query parameter, header or JSON body field), anywhere in the name; use
 * anchors for exact matches (`"^card_number$"`).
 *
 * Values are replaced with `[redacted]`; names stay visible so the request
 * log still shows *what* was sent, never the sensitive value itself.
 */
export class Redactor {
  readonly queryParams: RegExp;
  readonly headers: RegExp;
  readonly bodyFields: RegExp;

  /** @throws SyntaxError when a user pattern is not a valid regex. */
  constructor(options: RedactorOptions = {}) {
    // Compiled exactly once here; nothing is compiled per request.
    this.queryParams = compilePatterns(DEFAULT_MASK_QUERY_PARAMS, options.queryParams);
    this.headers =
      options.headers && options.headers.length > 0
        ? compilePatterns(DEFAULT_MASK_HEADER_PATTERNS, options.headers)
        : DEFAULT_HEADER_RE;
    this.bodyFields = compilePatterns(DEFAULT_MASK_BODY_FIELDS, options.bodyFields);
  }

  headerMatches(name: string): boolean {
    return this.headers.test(name);
  }

  /**
   * Redact matching parameter values within a raw query string (without the
   * leading `?`). A query with no matching parameter is returned unchanged,
   * byte for byte; unparseable input is passed through untouched.
   */
  redactQuery(query: string): string {
    if (!query) {
      return query;
    }
    try {
      const pairs = parseQuery(query);
      if (pairs.length === 0) {
        return query;
      }
      const pattern = this.queryParams;
      if (!pairs.some(([name]) => pattern.test(name))) {
        // Nothing sensitive: keep the original encoding byte-for-byte.
        return query;
      }
      return pairs
        .map(
          ([name, value]) =>
            `${quoteComponent(name)}=${pattern.test(name) ? REDACTED : quoteComponent(value)}`,
        )
        .join("&");
    } catch (_error) {
      return query;
    }
  }

  /**
   * Redact matching field values in a JSON body (recursively, up to
   * {@link MAX_BODY_DEPTH} levels).
   *
   * A matching field's value is masked when it is a string or a number, and
   * also when it is a nested object or array, which is masked whole.
   * Booleans and `null` carry no secret and stay visible. Bodies with no
   * matching field, and non-JSON payloads, are returned unchanged.
   */
  redactBody(payload: string): string {
    if (!payload) {
      return payload;
    }
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch (_error) {
      return payload;
    }
    if (data === null || typeof data !== "object") {
      return payload;
    }
    const pattern = this.bodyFields;
    let changed = false;

    const walk = (node: unknown, depth: number): unknown => {
      if (depth > MAX_BODY_DEPTH) {
        return node;
      }
      if (Array.isArray(node)) {
        return node.map((v) => walk(v, depth + 1));
      }
      if (node !== null && typeof node === "object") {
        // Null prototype: a "__proto__" key from the payload stays a plain key.
        const out: Record<string, unknown> = Object.create(null);
        for (const [key, value] of Object.entries(node)) {
          if (value !== null && typeof value !== "boolean" && pattern.test(key)) {
            out[key] = REDACTED;
            changed = true;
          } else {
            out[key] = walk(value, depth + 1);
          }
        }
        return out;
      }
      return node;
    };

    try {
      const result = walk(data, 0);
      return changed ? JSON.stringify(result) : payload;
    } catch (_error) {
      return payload;
    }
  }
}

/**
 * Serialize a header map to a compact JSON string, redacting secrets.
 *
 * Returns `""` when there are no headers. Names are lower-cased; values of
 * {@link SENSITIVE_HEADERS} and of names matching
 * {@link DEFAULT_MASK_HEADER_PATTERNS} become `[redacted]`; a `redactor`
 * adds the app's own header patterns on top. Multi-value headers (Node
 * arrays) are joined with `", "`. When the JSON exceeds `maxBytes` (UTF-8),
 * keys are dropped longest-value-first until it fits.
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
    safe.set(
      name,
      isSensitiveHeader(name, options.redactor) ? REDACTED : headerValueToString(value),
    );
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
