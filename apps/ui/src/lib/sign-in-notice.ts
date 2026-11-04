// The notice above the sign-in form (#318). Flows that end on `/sign-in` say why with a query
// parameter: `?reason=` for an expected landing (signed out, session expired) and `?error=` for a
// sign-in that failed (OAuth callback, SSO enforcement). The codes and their copy are documented
// in docs/architecture/identity.md, next to the error catalogue.
//
// The query value is never shown: it only selects one of the fixed sentences below, so a crafted
// link cannot put its own words on the sign-in page.
//
// Client-safe: no server imports.

export type SignInNoticeTone = "info" | "warn" | "error";

export interface SignInNotice {
  code: string;
  tone: SignInNoticeTone;
  /** One sentence that says what happened and what to do next. */
  text: string;
}

/** Copy per code. One sentence each: what happened, then the next action. */
export const SIGN_IN_NOTICES: Record<string, Omit<SignInNotice, "code">> = {
  signed_out: { tone: "info", text: "You’re signed out. Sign in again whenever you’re ready." },
  session_expired: { tone: "warn", text: "Your session expired. Sign in again to pick up where you left off." },
  account_deleted: {
    tone: "info",
    text: "Your account is scheduled for deletion and you’re signed out everywhere. It’s removed for good in 30 days.",
  },
  "2fa_locked": { tone: "warn", text: "Too many wrong two-factor codes. Sign in again to start over." },
  "2fa_expired": { tone: "warn", text: "Your two-factor step timed out. Sign in again to continue." },
  oauth_email_unverified: {
    tone: "error",
    text: "That provider account has no verified email. Verify it with the provider, or sign in with an email code.",
  },
  oauth_identity_taken: {
    tone: "error",
    text: "That provider account is already linked to a different APILens account. Sign in to that account instead.",
  },
  account_deleting: {
    tone: "warn",
    text: "This account is scheduled for deletion, so it can’t sign in. Contact support to restore it.",
  },
  sso_required: {
    tone: "info",
    text: "Your organization requires single sign-on. Sign in through your company’s identity provider.",
  },
};

/** Shown for an `?error=` code this page does not know. */
export const GENERIC_SIGN_IN_NOTICE: Omit<SignInNotice, "code"> = {
  tone: "error",
  text: "Sign-in didn’t complete. Try again.",
};

const CODE = /^[a-z0-9_]{1,64}$/;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Picks the notice for the sign-in page's query. `error` wins over `reason`. A known code gets its
 * own sentence; any other `error` value (unknown or malformed) gets the generic line; an unknown
 * `reason` shows nothing, because a reason is informational and never a failure.
 */
export function signInNotice(params: {
  error?: string | string[];
  reason?: string | string[];
}): SignInNotice | null {
  const error = first(params.error);
  if (error !== undefined && error !== "") {
    const code = CODE.test(error) ? error : "unknown";
    const known = Object.hasOwn(SIGN_IN_NOTICES, code) ? SIGN_IN_NOTICES[code] : null;
    return { code: known ? code : "unknown", ...(known ?? GENERIC_SIGN_IN_NOTICE) };
  }
  const reason = first(params.reason);
  if (reason && CODE.test(reason) && Object.hasOwn(SIGN_IN_NOTICES, reason)) {
    return { code: reason, ...SIGN_IN_NOTICES[reason] };
  }
  return null;
}

/** The current URL with `error` and `reason` removed, so a dismissed notice stays gone on reload. */
export function withoutNoticeParams(href: string): string {
  const url = new URL(href, "http://x");
  url.searchParams.delete("error");
  url.searchParams.delete("reason");
  const q = url.searchParams.toString();
  return `${url.pathname}${q ? `?${q}` : ""}${url.hash}`;
}
