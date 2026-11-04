// Organization slugs on "Name your organization" (#330): turning a name into an address, the
// live availability check (`GET /api/orgs/slug-available`, debounced, the previous request
// cancelled on every keystroke) and the answer of the create action. No React and no server
// imports, so it can be unit tested and used from the browser.

/** The API's slug rule (`CreateOrgInput.Slug`): lower-case letters, digits and hyphens. */
export const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Longest address the screen derives from a name. */
const SLUGIFY_MAX = 32;

/** The address a name suggests: lower-case, runs of anything else become one hyphen. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUGIFY_MAX)
    .replace(/-+$/, "");
}

/** Whether `slug` is worth asking about: valid for the API and at least two characters. */
export function checkableSlug(slug: string): boolean {
  return slug.length > 1 && ORG_SLUG.test(slug);
}

/** What the screen knows about an address. */
export type SlugStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken"; suggestions: string[]; raced?: boolean }
  /** The check failed (network, rate limit): Create stays allowed and the API decides. */
  | { kind: "unknown" };

/** Up to three valid suggestions out of whatever the server answered. */
export function cleanSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string" && ORG_SLUG.test(s)).slice(0, 3);
}

/** Reads the Route Handler's answer: `{ok: true, available, suggestions}`. */
export function parseAvailability(body: unknown): SlugStatus {
  if (typeof body !== "object" || body === null) return { kind: "unknown" };
  const b = body as Record<string, unknown>;
  if (b.ok !== true || typeof b.available !== "boolean") return { kind: "unknown" };
  return b.available ? { kind: "available" } : { kind: "taken", suggestions: cleanSuggestions(b.suggestions) };
}

/** Milliseconds of quiet typing before the address is checked. */
export const SLUG_CHECK_DELAY_MS = 300;
/** Where the browser asks. */
export const SLUG_CHECK_PATH = "/api/orgs/slug-available";

export interface SlugCheckerOptions {
  /** Receives every answer, for the slug most recently passed to `check`. */
  onResult: (slug: string, status: SlugStatus) => void;
  fetch?: typeof fetch;
  delayMs?: number;
}

/**
 * Debounced availability checks. Every `check` (one per keystroke) cancels the pending timer and
 * aborts the request still in flight, so only the latest address is ever answered.
 */
export function createSlugChecker({ onResult, fetch: doFetch = (...a) => fetch(...a), delayMs = SLUG_CHECK_DELAY_MS }: SlugCheckerOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    inFlight?.abort();
    inFlight = null;
  };

  const check = (slug: string) => {
    cancel();
    if (!checkableSlug(slug)) return;
    timer = setTimeout(async () => {
      timer = null;
      const ctl = new AbortController();
      inFlight = ctl;
      let status: SlugStatus;
      try {
        const res = await doFetch(`${SLUG_CHECK_PATH}?${new URLSearchParams({ slug })}`, {
          signal: ctl.signal,
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        status = parseAvailability(await res.json().catch(() => null));
      } catch {
        status = { kind: "unknown" };
      }
      if (ctl.signal.aborted) return;
      inFlight = null;
      onResult(slug, status);
    }, delayMs);
  };

  return { check, cancel };
}

/** The create action's answer. */
export type CreateOrgResult =
  | { ok: true; slug: string }
  | { ok: false; code: "slug_taken"; suggestions: string[] }
  | { ok: false; code: string; error: string };

/** A sentence for a failed create, by API error code (slug_taken is shown on the field instead). */
export function createOrgError(code: string): string {
  switch (code) {
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "That name or address isn’t allowed. Check them and try again.";
    case "rate_limited":
      return "Too many attempts in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens to create your organization. Check your connection and try again.";
    default:
      return "We couldn’t create your organization. Try again in a moment.";
  }
}
