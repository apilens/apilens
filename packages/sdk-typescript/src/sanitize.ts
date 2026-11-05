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

/**
 * Stored in place of a whole body that a mask callback dropped (returned
 * `null`) or failed on (threw / returned something that is not a `Buffer`).
 */
export const MASKED = "[masked]";

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
 * Media types whose bodies are captured by default. Anything else (multipart
 * uploads, images, archives, octet streams, ...) is never buffered and is
 * stored as an `[<content-type>, N bytes omitted]` placeholder. Entries are
 * shell-style globs matched case-insensitively against the media type with
 * parameters (`; charset=...`) stripped. `captureContentTypes` replaces this
 * list.
 */
export const DEFAULT_CAPTURE_CONTENT_TYPES: readonly string[] = [
  "application/json",
  "application/*+json",
  "text/*",
  "application/x-www-form-urlencoded",
];

/** Form-encoded bodies are masked field by field like a query string. */
export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** What a body with no Content-Type is treated as (RFC 9110 section 8.3). */
const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

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
 * Replace the values of sensitive `name=value` pairs in url-encoded text.
 * Text with no sensitive pair is returned unchanged, byte for byte;
 * unparseable input is passed through untouched.
 */
function redactPairs(encoded: string, sensitive: (name: string) => boolean): string {
  if (!encoded) {
    return encoded;
  }
  try {
    const pairs = parseQuery(encoded);
    if (pairs.length === 0) {
      return encoded;
    }
    if (!pairs.some(([name]) => sensitive(name))) {
      // Nothing sensitive: keep the original encoding byte-for-byte.
      return encoded;
    }
    return pairs
      .map(
        ([name, value]) =>
          `${quoteComponent(name)}=${sensitive(name) ? REDACTED : quoteComponent(value)}`,
      )
      .join("&");
  } catch (_error) {
    return encoded;
  }
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
    const pattern = this.queryParams;
    return redactPairs(query, (name) => pattern.test(name));
  }

  /**
   * Redact matching field values in an `application/x-www-form-urlencoded`
   * body. A form field is masked when its name matches the body field
   * patterns or the query parameter patterns (built-ins included), so
   * `password=x` is stored as `password=[redacted]`. Bodies with no matching
   * field are returned byte for byte.
   */
  redactForm(payload: string): string {
    const body = this.bodyFields;
    const query = this.queryParams;
    return redactPairs(payload, (name) => body.test(name) || query.test(name));
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

/** `"Application/JSON; charset=utf-8"` -> `"application/json"`. */
export function mediaType(contentType: string | null | undefined): string {
  return String(contentType || "").split(";", 1)[0].trim().toLowerCase();
}

/** Python `fnmatch.fnmatchcase` for the `*` / `?` globs content types use. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .split("")
    .map((ch) => {
      if (ch === "*") {
        return ".*";
      }
      if (ch === "?") {
        return ".";
      }
      return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

/**
 * Decides from the Content-Type whether a body is captured at all.
 *
 * Built once per middleware from `captureContentTypes` (default
 * {@link DEFAULT_CAPTURE_CONTENT_TYPES}). Patterns are shell-style globs
 * (`text/*`, `application/*+json`) matched case-insensitively against the
 * media type without parameters. A body with no Content-Type is treated as
 * `application/octet-stream`.
 */
export class ContentTypeFilter {
  readonly patterns: readonly string[];
  private readonly matchers: readonly RegExp[];

  constructor(patterns?: string | ReadonlyArray<string> | null) {
    const list =
      patterns === undefined || patterns === null
        ? DEFAULT_CAPTURE_CONTENT_TYPES
        : typeof patterns === "string"
          ? patterns.split(",")
          : patterns;
    this.patterns = [
      ...new Set(
        list.map((p) => String(p || "").trim().toLowerCase()).filter((p) => p.length > 0),
      ),
    ];
    this.matchers = this.patterns.map(globToRegExp);
  }

  allows(contentType: string | null | undefined): boolean {
    const mt = mediaType(contentType) || UNKNOWN_CONTENT_TYPE;
    return this.matchers.some((re) => re.test(mt));
  }
}

/**
 * Placeholder stored instead of a body whose content type is not captured.
 * Returns `""` for an empty body, so a bodiless request stays empty.
 */
export function omittedBody(contentType: string | null | undefined, size: number): string {
  const n = Math.max(Math.floor(Number(size) || 0), 0);
  if (n === 0) {
    return "";
  }
  return `[${mediaType(contentType) || UNKNOWN_CONTENT_TYPE}, ${n} bytes omitted]`;
}

/**
 * What a `maskRequestBody` callback is told about the request.
 *
 * `path` is the request path without query string; `rawPath` is the exact URL
 * with sensitive query values already redacted. `headers` are the request
 * headers with lower-cased names, unredacted (the callback runs in-process;
 * nothing has left the app yet).
 */
export type RequestBodyInfo = {
  readonly method: string;
  readonly path: string;
  readonly rawPath: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string;
};

/** What a `maskResponseBody` callback is told about the response. */
export type ResponseBodyInfo = {
  readonly request: RequestBodyInfo;
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string;
};

/**
 * `(info, body) => Buffer | null`: return the (possibly rewritten) body bytes,
 * or `null` to drop the whole body (stored as {@link MASKED}). A string
 * return is accepted and UTF-8 encoded; anything else, or a throw, also
 * stores {@link MASKED}.
 */
export type BodyMasker<Info> = (info: Info, body: Buffer) => Buffer | string | null | undefined;
export type RequestBodyMasker = BodyMasker<RequestBodyInfo>;
export type ResponseBodyMasker = BodyMasker<ResponseBodyInfo>;

/** Header map with lower-cased names and string values, for the mask callback infos. */
export function lowerHeaders(headers: HeaderMap | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key && value !== undefined && value !== null) {
      out[key.toLowerCase()] = headerValueToString(value);
    }
  }
  return out;
}

/**
 * Decode UTF-8, dropping an incomplete multibyte sequence at the tail.
 *
 * Payloads are captured by byte budget, so the cut can land in the middle of
 * a multibyte character; trimming the dangling bytes avoids a trailing `�`.
 */
export function decodeUtf8Safe(data: Buffer): string {
  if (!data || data.length === 0) {
    return "";
  }
  let cut = data.length;
  // Walk back to the lead byte of the last character (at most 3 continuation bytes).
  let i = cut - 1;
  while (i > 0 && cut - i < 4 && (data[i] & 0xc0) === 0x80) {
    i -= 1;
  }
  const lead = data[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (lead >= 0xc0 && cut - i < need) {
    cut = i;
  }
  return data.subarray(0, cut).toString("utf8");
}

export type MaskBodyOptions<Info> = {
  redactor: Redactor;
  masker?: BodyMasker<Info> | null;
  info?: Info;
  contentType?: string | null;
};

/**
 * Turn captured body bytes into the payload string that is sent.
 *
 * Order is fixed: the user `masker` callback runs first on the (already
 * truncated) raw bytes, then the result is decoded and the regex field
 * masking (user patterns plus the built-in defaults) is applied by
 * `redactor`. The callback can rewrite or drop the body but can never switch
 * the built-ins off. Form-encoded bodies are masked field by field
 * ({@link Redactor.redactForm}); everything else goes through the JSON field
 * masking (a no-op for non-JSON text).
 *
 * Fail closed: if the callback returns `null`/`undefined`, throws, or returns
 * something that is not a `Buffer`/`Uint8Array`/string, the whole body
 * becomes {@link MASKED}; the raw body is never sent in that case.
 */
export function maskBody<Info>(body: Buffer, options: MaskBodyOptions<Info>): string {
  if (!body || body.length === 0) {
    return "";
  }
  let bytes = body;
  if (options.masker) {
    let result: unknown;
    try {
      // A copy: the callback cannot mutate the captured buffer.
      result = options.masker(options.info as Info, Buffer.from(body));
    } catch (_error) {
      return MASKED;
    }
    if (typeof result === "string") {
      bytes = Buffer.from(result, "utf8");
    } else if (result instanceof Uint8Array) {
      bytes = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
    } else {
      return MASKED;
    }
  }
  const text = decodeUtf8Safe(bytes);
  if (mediaType(options.contentType) === FORM_CONTENT_TYPE) {
    return options.redactor.redactForm(text);
  }
  return options.redactor.redactBody(text);
}

export type CaptureBodyOptions<Info> = MaskBodyOptions<Info> & {
  /** Full body length in bytes, for the omitted-body placeholder. */
  size: number;
  contentTypes: ContentTypeFilter;
};

/**
 * The payload string for one captured side (request or response). A body
 * whose content type `contentTypes` does not allow is stored as the
 * {@link omittedBody} placeholder (callers must not have buffered it); an
 * allowed body goes through {@link maskBody}.
 */
export function captureBody<Info>(body: Buffer, options: CaptureBodyOptions<Info>): string {
  if (!options.contentTypes.allows(options.contentType)) {
    return omittedBody(options.contentType, options.size);
  }
  return maskBody(body, options);
}
