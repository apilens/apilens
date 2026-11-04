// "Continue with SSO" on the sign-in and sign-up pages (#323).
//
// Once a work email is typed, the page asks `POST /api/auth/sso/lookup` (which calls identity's
// `GET /api/v1/auth/sso/lookup`) whether the email's domain signs in through an organization's
// single sign-on:
//
// - enforced: the primary action becomes "Continue with <org> SSO", a plain link to identity's
//   `start_url`; no email code is offered (identity would refuse it with 403 `sso_required`).
// - available, not enforced: the same link is added as a secondary button.
// - no match (or the lookup failed): the page is unchanged. Identity still enforces SSO when the
//   code is requested, answering 403 `sso_required` with the `start_url`, so a failed lookup
//   never lets a code through.
//
// Client-safe: no server imports. The Route Handler shares {@link ssoStartHref}.

/** Same as social sign-in (`OAUTH_REMEMBER`): an SSO sign-in has no form to ask on. */
export const SSO_REMEMBER = true;

export const SSO_LOOKUP_PATH = "/api/auth/sso/lookup";

/** An organization's SSO for the typed email. */
export interface SSOMatch {
  /** Display name, or null when unknown (a `sso_required` refusal carries none). */
  orgName: string | null;
  enforced: boolean;
  /** Absolute URL of identity's SSO start, already carrying `next`, `remember` and `login_hint`. */
  startUrl: string;
}

export type SSOLookupResult = { kind: "match"; match: SSOMatch } | { kind: "none" } | { kind: "error" };

/**
 * Identity's `start_url` with the sign-in's `next`, `remember` and `login_hint` (the typed email,
 * which the provider pre-fills). Null unless `startUrl` is an absolute http(s) URL, so a bad
 * answer can never become a `javascript:` link.
 */
export function ssoStartHref(startUrl: unknown, opts: { email?: string; next?: string } = {}): string | null {
  if (typeof startUrl !== "string" || startUrl === "") return null;
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (opts.next) url.searchParams.set("next", opts.next);
  url.searchParams.set("remember", String(SSO_REMEMBER));
  if (opts.email) url.searchParams.set("login_hint", opts.email);
  return url.href;
}

/** The match a `sso_required` refusal implies, or null when it carried no usable `start_url`. */
export function ssoRequiredMatch(startUrl: unknown): SSOMatch | null {
  const href = ssoStartHref(startUrl);
  return href ? { orgName: null, enforced: true, startUrl: href } : null;
}

/** Asks the Route Handler about `email`'s domain. Never throws. */
export async function lookupSSO(
  input: { email: string; next?: string },
  fetcher: typeof fetch = fetch,
): Promise<SSOLookupResult> {
  const body: Record<string, string> = { email: input.email.trim() };
  if (input.next) body.next = input.next;
  let data: Record<string, unknown>;
  try {
    const res = await fetcher(SSO_LOOKUP_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) return { kind: "error" };
    const parsed: unknown = await res.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "error" };
    data = parsed as Record<string, unknown>;
  } catch {
    return { kind: "error" };
  }
  if (data.ok !== true) return { kind: "error" };
  if (data.sso !== true) return { kind: "none" };
  const startUrl = ssoStartHref(data.start_url);
  if (!startUrl) return { kind: "none" };
  const orgName = typeof data.org_name === "string" && data.org_name.trim() !== "" ? data.org_name.trim() : null;
  // The Route Handler has already added next/remember/login_hint; keep its URL as is.
  return { kind: "match", match: { orgName, enforced: data.enforced === true, startUrl: data.start_url as string } };
}

/** The button label: "Continue with Acme SSO", or "Continue with SSO" without a name. */
export function ssoLabel(orgName: string | null): string {
  return orgName ? `Continue with ${orgName} SSO` : "Continue with SSO";
}

/** Inline copy for the generic SSO button. */
export const SSO_NEEDS_EMAIL = "Enter your work email to continue with SSO.";
export const SSO_NOT_SET_UP = "Single sign-on isn’t set up for that email’s domain. Use another way to sign in.";
export const SSO_LOOKUP_FAILED = "We couldn’t check single sign-on right now. Try again in a moment.";
