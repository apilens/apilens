// Project settings → Privacy (#599): the project's server-side deny list (`GET|PUT
// /projects/{slug}/privacy-policy`, #562). The editor's checks on each pattern, the lists as the
// API wants them, the live tester's inputs, and the sentences shown for the server's error codes.
// The server stays the authority (it compiles every pattern as RE2); these checks only spare a
// round trip. Pure; safe in Client Components and Server Actions alike.
import type { PrivacyPolicy, PutPrivacyPolicyRequest } from "./identity";
import { BUILT_IN_DEFAULTS, type PatternLists, type Redactor, type RedactorDefaults } from "./privacy-redact";

/** The section of project settings that edits the deny list. */
export const PRIVACY_SECTION = "privacy";

/** `/<project>/settings/privacy`. */
export function privacyPath(project: string): string {
  return `/${project}/settings/${PRIVACY_SECTION}`;
}

/** Most patterns per list (`maxItems`, `privacy.MaxPatterns`). */
export const MAX_PATTERNS = 50;
/** Longest pattern, in UTF-8 bytes (`privacy.MaxPatternLen`). */
export const MAX_PATTERN_BYTES = 256;

/** How long until the ingest edges apply a saved policy: the app cache TTL (`ingest.app_cache_ttl`). */
export const APPLIES_WITHIN = "60 s";

export type ListKey = keyof PatternLists;

/** The three lists, in the order the page shows them. */
export const LISTS: readonly { key: ListKey; title: string; help: string; placeholder: string }[] = [
  {
    key: "mask_query_params",
    title: "Query parameters",
    help: "Names of query parameters in the request URL. Their values are masked, the names stay.",
    placeholder: "e.g. ^session_id$",
  },
  {
    key: "mask_headers",
    title: "Headers",
    help: "Names of captured request and response headers.",
    placeholder: "e.g. ^x-tenant-.*$",
  },
  {
    key: "mask_body_fields",
    title: "Body fields",
    help: "Names of JSON body fields, at any depth. String and number values are masked.",
    placeholder: "e.g. ^(email|phone)$",
  },
];

/** The editor's lists as typed, one string per row (rows may be blank or invalid). */
export type PrivacyDraft = Record<ListKey, string[]>;

export function draftOf(p: PatternLists): PrivacyDraft {
  return { mask_query_params: [...p.mask_query_params], mask_headers: [...p.mask_headers], mask_body_fields: [...p.mask_body_fields] };
}

/** The built-ins as the API answered them, else the ones this build knows. */
export function defaultsOf(p: PrivacyPolicy | null): RedactorDefaults {
  const d = p?.defaults;
  if (!d) return BUILT_IN_DEFAULTS;
  return {
    mask_query_params: d.mask_query_params ?? [],
    mask_headers: d.mask_headers ?? [],
    mask_body_fields: d.mask_body_fields ?? [],
    sensitive_headers: d.sensitive_headers ?? [],
  };
}

/** The saveable lists of a policy read from the API. */
export function listsOf(p: PrivacyPolicy): PutPrivacyPolicyRequest {
  return { mask_query_params: p.mask_query_params ?? [], mask_headers: p.mask_headers ?? [], mask_body_fields: p.mask_body_fields ?? [] };
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

// What RE2 refuses but JavaScript accepts: lookarounds and backreferences.
const LOOKAROUND = /\(\?<?[=!]/;
const BACKREF = /\\(?:[1-9]|k<)/;

/** Why a (trimmed, non-empty) pattern cannot be saved, or null when it can. */
export function patternError(pattern: string): string | null {
  if (utf8Bytes(pattern) > MAX_PATTERN_BYTES) return `Keep patterns to ${MAX_PATTERN_BYTES} bytes or fewer.`;
  if (LOOKAROUND.test(pattern.replace(/\\./g, ""))) return "Lookarounds aren’t supported. Patterns use RE2 syntax.";
  if (BACKREF.test(pattern.replace(/\\\\/g, ""))) return "Backreferences aren’t supported. Patterns use RE2 syntax.";
  try {
    new RegExp(pattern, "i");
  } catch {
    return "This isn’t a valid regular expression. Check for unbalanced brackets or parentheses.";
  }
  return null;
}

/** Per list, the error of each row by index (blank rows have none). */
export type DraftErrors = Partial<Record<ListKey, Record<number, string>>>;

/**
 * The lists as the API wants them (trimmed, blanks dropped), or each row's error: invalid
 * patterns, a row repeating an earlier one, and lists over {@link MAX_PATTERNS}.
 */
export function checkDraft(d: PrivacyDraft): { ok: true; policy: PutPrivacyPolicyRequest } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const policy: PutPrivacyPolicyRequest = { mask_query_params: [], mask_headers: [], mask_body_fields: [] };
  for (const { key } of LISTS) {
    const seen = new Set<string>();
    d[key].forEach((raw, i) => {
      const p = raw.trim();
      if (p === "") return;
      const err = seen.has(p) ? "Already in this list." : policy[key].length >= MAX_PATTERNS ? `At most ${MAX_PATTERNS} patterns per list.` : patternError(p);
      if (err) {
        errors[key] = { ...errors[key], [i]: err };
        return;
      }
      seen.add(p);
      policy[key].push(p);
    });
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, policy };
}

/** The valid patterns of a draft, for the tester while some rows are still being fixed. */
export function validLists(d: PrivacyDraft): PatternLists {
  const pick = (rows: string[]) => [...new Set(rows.map((r) => r.trim()).filter((p) => p !== "" && patternError(p) === null))];
  return { mask_query_params: pick(d.mask_query_params), mask_headers: pick(d.mask_headers), mask_body_fields: pick(d.mask_body_fields) };
}

/** Checks a body a Server Action received against the API's rules. */
export function checkLists(value: unknown): { ok: true; policy: PutPrivacyPolicyRequest } | { ok: false; error: string } {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const draft = {} as PrivacyDraft;
  for (const { key } of LISTS) {
    const list = v[key] ?? [];
    if (!Array.isArray(list) || list.length > MAX_PATTERNS * 4 || list.some((p) => typeof p !== "string")) return { ok: false, error: privacyError("invalid_request") };
    draft[key] = list as string[];
  }
  const checked = checkDraft(draft);
  return checked.ok ? checked : { ok: false, error: privacyError("invalid_request") };
}

/** Whether two policies save the same lists. */
export function sameLists(a: PatternLists, b: PatternLists): boolean {
  return LISTS.every(({ key }) => a[key].length === b[key].length && a[key].every((p, i) => p === b[key][i]));
}

/**
 * The row a server `invalid_request` detail names ("mask_headers[2]: not a valid RE2 pattern"),
 * as an index into the saved (trimmed, blank-free) list.
 */
export function rowOfDetail(detail: string | undefined): { key: ListKey; index: number; reason: string } | null {
  const m = /^(mask_query_params|mask_headers|mask_body_fields)\[(\d+)\]: (.+)$/.exec(detail ?? "");
  return m ? { key: m[1] as ListKey, index: Number(m[2]), reason: m[3] as string } : null;
}

/** The tester's sample request. */
export interface Sample {
  /** A path or full URL, with its query string. */
  url: string;
  /** `Name: value` lines, or a JSON object as the SDKs capture headers. */
  headers: string;
  body: string;
}

export const SAMPLE: Sample = {
  url: "/v1/orders?page=2&api_key=sk_live_51H8&session_id=8f3a",
  headers: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9\nContent-Type: application/json\nX-Tenant-Id: acme",
  body: '{\n  "email": "ada@example.com",\n  "password": "hunter2",\n  "card": { "card_number": "4242424242424242", "cvc": 123 },\n  "items": [{ "sku": "A-1", "qty": 2 }]\n}',
};

/** `Name: value` lines as the header JSON object the edge masks; null when they are not header lines. */
export function headerLinesToJSON(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const obj: Record<string, string> = {};
  for (const line of lines) {
    const m = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s?(.*)$/.exec(line);
    if (!m) return null;
    obj[m[1] as string] = m[2] as string;
  }
  return JSON.stringify(obj);
}

/** The masked sample, as the edge would store it. Headers typed as lines come back as lines. */
export function testSample(r: Redactor, s: Sample): Sample {
  let headers: string;
  const asJSON = s.headers.trimStart().startsWith("{") ? null : headerLinesToJSON(s.headers);
  if (asJSON === null) headers = r.headers(s.headers);
  else {
    const masked = JSON.parse(r.headers(asJSON)) as Record<string, string>;
    headers = Object.entries(masked)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }
  return { url: r.rawPath(s.url.trim()), headers, body: r.body(s.body) };
}

/** The sentence the privacy page shows for an API error `code`. */
export function privacyError(code: string): string {
  switch (code) {
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some patterns weren’t accepted. Fix the highlighted ones and try again.";
    case "forbidden":
      return "You can’t change this project’s privacy policy. Ask a project admin.";
    case "not_found":
      return "This project no longer exists, or you’re no longer a member of it.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
