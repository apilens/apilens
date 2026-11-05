// Project settings → Privacy (#599): a client-side port of the ingest edge's redactor
// (internal/controlplane/privacy/redact.go), so the live tester shows what the edge would store
// without a round trip. Same semantics, line for line: names are matched case-insensitively
// against the built-in defaults plus the policy's patterns, values become "[redacted]", names and
// formatting stay. `privacy-redact.test.ts` checks it against the vectors Go is checked against
// (internal/controlplane/privacy/testdata/redact_vectors.json); change both together.
//
// Patterns are RE2 on the server and JavaScript regular expressions here. For the patterns the
// form accepts (see `checkPattern` in privacy-policy.ts) the two agree on what a name matches.
// Pure; safe in Client Components.

/** Replaces every masked value. */
export const REDACTED = "[redacted]";

/** The built-in patterns (`DefaultQueryParams` etc.); the API also sends them as `defaults`. */
export const DEFAULT_QUERY_PARAMS: readonly string[] = ["auth", "api.?key", "secret", "token", "password", "pwd"];
export const DEFAULT_HEADERS: readonly string[] = ["auth", "api.?key", "secret", "token", "cookie"];
export const DEFAULT_BODY_FIELDS: readonly string[] = ["password", "pwd", "token", "secret", "auth", "card.?number", "ccv", "cvv", "cvc", "ssn"];
/** Header names (lower case, matched exactly) whose values are always replaced. */
export const SENSITIVE_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-amz-security-token",
  "x-csrf-token",
];

/** The pattern lists of one policy (the API's field names). */
export interface PatternLists {
  mask_query_params: readonly string[];
  mask_headers: readonly string[];
  mask_body_fields: readonly string[];
}

/** The built-ins the redactor starts from; the page passes the ones the API answered. */
export interface RedactorDefaults extends PatternLists {
  sensitive_headers: readonly string[];
}

export const BUILT_IN_DEFAULTS: RedactorDefaults = {
  mask_query_params: DEFAULT_QUERY_PARAMS,
  mask_headers: DEFAULT_HEADERS,
  mask_body_fields: DEFAULT_BODY_FIELDS,
  sensitive_headers: SENSITIVE_HEADERS,
};

/** How deep a JSON body is walked; the edge and the SDKs use the same limit. */
const MAX_BODY_DEPTH = 32;

const QUOTED_REDACTED = `"${REDACTED}"`;

/** RE2's `\s`, which is narrower than JavaScript's. */
const SP = "[\\t\\n\\f\\r ]";

// `kv` of redact.go: key=value and key: value pairs in free text. RE2's `(?i:bearer|...)` is
// spelled out per letter, which every JavaScript engine accepts.
const ci = (word: string) => [...word].map((c) => `[${c.toUpperCase()}${c}]`).join("");
const SCHEME = `(?:${["bearer", "basic", "token", "digest"].map(ci).join("|")})${SP}+`;
const KV_SOURCE = `([A-Za-z_][A-Za-z0-9_.\\-]*)("?${SP}*[=:]${SP}*)((?:${SCHEME})?(?:"[^"]*"|'[^']*'|[^\\t\\n\\f\\r ,;&"'<>{}\\[\\]]+))`;

/** One case-insensitive alternation of the non-empty, distinct patterns. */
function union(patterns: readonly string[]): RegExp {
  const parts: string[] = [];
  for (const p of new Set(patterns)) if (p !== "") parts.push(`(?:${p})`);
  return new RegExp(parts.join("|"), "i");
}

export interface Redactor {
  /** Masks matching query parameter values in a path or URL with a query string. */
  rawPath(s: string): string;
  /** Masks matching values in a captured header JSON object, or in header text. */
  headers(s: string): string;
  /** Masks matching string and number values in a JSON body, or key=value pairs in other text. */
  body(s: string): string;
  /** Masks key=value pairs in free text (log messages). */
  text(s: string): string;
  headerMatches(name: string): boolean;
}

/**
 * The redactor of `defaults` plus every policy in `policies`. Throws a SyntaxError when a pattern
 * does not compile; the form checks each one first.
 */
export function compileRedactor(defaults: RedactorDefaults, ...policies: PatternLists[]): Redactor {
  const query = [...defaults.mask_query_params, ...policies.flatMap((p) => p.mask_query_params)];
  const headers = [...defaults.mask_headers, ...policies.flatMap((p) => p.mask_headers)];
  const body = [...defaults.mask_body_fields, ...policies.flatMap((p) => p.mask_body_fields)];
  const exact = new Set(defaults.sensitive_headers.map((h) => h.toLowerCase()));
  const queryRe = union(query);
  const headersRe = union(headers);
  const bodyRe = union(body);
  const textRe = union([...query, ...headers, ...body]);

  const headerMatches = (name: string) => exact.has(name.toLowerCase()) || headersRe.test(name);

  const maskQuery = (q: string): string | null => {
    if (q === "") return null;
    const parts = q.split("&");
    let changed = false;
    parts.forEach((part, i) => {
      const eq = part.indexOf("=");
      if (eq < 0) return;
      const k = part.slice(0, eq);
      if (part.slice(eq + 1) === REDACTED) return;
      if (queryRe.test(queryUnescape(k))) {
        parts[i] = `${k}=${REDACTED}`;
        changed = true;
      }
    });
    return changed ? parts.join("&") : null;
  };

  const rawPath = (s: string): string => {
    const i = s.indexOf("?");
    if (i < 0) return s;
    let q = s.slice(i + 1);
    let frag = "";
    const j = q.indexOf("#");
    if (j >= 0) {
      frag = q.slice(j);
      q = q.slice(0, j);
    }
    const masked = maskQuery(q);
    return masked === null ? s : s.slice(0, i + 1) + masked + frag;
  };

  const text = (s: string): string => {
    const kv = new RegExp(KV_SOURCE, "dg");
    let out = "";
    let last = 0;
    let pos = 0;
    while (pos < s.length) {
      kv.lastIndex = pos;
      const m = kv.exec(s);
      if (!m?.indices) break;
      const [, key, , value] = m;
      const [vStart, vEnd] = m.indices[3] as [number, number];
      if (value === REDACTED || value === QUOTED_REDACTED || (!exact.has((key as string).toLowerCase()) && !textRe.test(key as string))) {
        pos = vStart;
        continue;
      }
      out += s.slice(last, vStart) + ((value as string).startsWith('"') ? QUOTED_REDACTED : REDACTED);
      last = vEnd;
      pos = vEnd;
    }
    if (last === 0) return s;
    return out + s.slice(last);
  };

  return {
    rawPath,
    headerMatches,
    text,
    headers: (s) => {
      if (s === "") return s;
      if (!looksLike(s, "{") || !isJSON(s)) return text(s);
      return maskJSON(s, headerMatches, true);
    },
    body: (s) => {
      if (s === "") return s;
      if ((!looksLike(s, "{") && !looksLike(s, "[")) || !isJSON(s)) return text(s);
      return maskJSON(s, (k) => bodyRe.test(k), false);
    },
  };
}

/** Go's url.QueryUnescape, falling back to the raw name when it is not a valid escape. */
function queryUnescape(k: string): string {
  try {
    return decodeURIComponent(k.replace(/\+/g, " "));
  } catch {
    return k;
  }
}

function isJSON(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function looksLike(s: string, open: string): boolean {
  const t = s.replace(/^[ \t\r\n]+/, "");
  return t !== "" && t[0] === open;
}

/** `maskJSON` of redact.go: one pass over valid JSON, replacing only the matched values. */
function maskJSON(s: string, match: (key: string) => boolean, topOnly: boolean): string {
  let out = "";
  let last = 0;
  let changed = false;
  const stack: string[] = [];
  let wantKey = false;
  const verdicts = new Map<string, boolean>();
  const matches = (key: string) => {
    let v = verdicts.get(key);
    if (v === undefined) {
      v = match(key);
      verdicts.set(key, v);
    }
    return v;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "{" || c === "[") {
      stack.push(c);
      wantKey = c === "{";
      i++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      wantKey = false;
      i++;
    } else if (c === ",") {
      wantKey = stack.length > 0 && stack[stack.length - 1] === "{";
      i++;
    } else if (c === '"') {
      const end = stringEnd(s, i);
      if (!wantKey) {
        i = end;
        continue;
      }
      wantKey = false;
      let j = skipSpace(s, end);
      j = skipSpace(s, j + 1);
      const considered = stack.length <= MAX_BODY_DEPTH + 1 && (!topOnly || stack.length === 1);
      if (!considered || !matches(unquote(s.slice(i, end)))) {
        i = j;
        continue;
      }
      let vend: number;
      const v = s[j] as string;
      if (topOnly) vend = valueEnd(s, j);
      else if (v === '"') vend = stringEnd(s, j);
      else if (v === "-" || (v >= "0" && v <= "9")) vend = numberEnd(s, j);
      else {
        // object, array, true, false, null: walk on
        i = j;
        continue;
      }
      if (s.slice(j, vend) !== QUOTED_REDACTED) {
        out += s.slice(last, j) + QUOTED_REDACTED;
        last = vend;
        changed = true;
      }
      i = vend;
    } else {
      i++;
    }
  }
  if (!changed) return s;
  return out + s.slice(last);
}

function stringEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === '"') return j + 1;
  }
  return s.length;
}

function numberEnd(s: string, i: number): number {
  while (i < s.length && "+-.eE0123456789".includes(s[i] as string)) i++;
  return i;
}

function valueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (d === '"') j = stringEnd(s, j) - 1;
      else if (d === "{" || d === "[") depth++;
      else if ((d === "}" || d === "]") && --depth === 0) return j + 1;
    }
    return s.length;
  }
  let j = i;
  while (j < s.length && !" \t\r\n,}]".includes(s[j] as string)) j++;
  return j;
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\r" || s[i] === "\n")) i++;
  return i;
}

/** Decodes a JSON string token, falling back to its raw inside. */
function unquote(tok: string): string {
  const inner = tok.slice(1, -1);
  if (!inner.includes("\\")) return inner;
  try {
    const v: unknown = JSON.parse(tok);
    return typeof v === "string" ? v : inner;
  } catch {
    return inner;
  }
}
