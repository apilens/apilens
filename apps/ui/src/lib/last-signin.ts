// How this browser last signed in, for "Last time you signed in as …" on /sign-in. It lives in
// `localStorage` and nothing leaves the browser. Storage can be blocked or hold junk, so every
// access is wrapped and anything unexpected reads as "nothing remembered".
//
// Google, GitHub and SSO leave the page, so the click only marks the method as pending (this tab
// only) and the server's one-shot cookie, set when the session is created, completes it.

export type SignInMethod = "email" | "google" | "github" | "sso" | "passkey";

import { forgetAccount, rememberAccount } from "./remembered-account";

const KEY = "apilens.last-signin";
const PENDING_KEY = "apilens.signin-pending";
/** Set by `/auth/callback` once a session exists; holds the address, lives two minutes. */
export const SIGNED_IN_COOKIE = "apilens_signed_in";

const METHODS: readonly string[] = ["email", "google", "github", "sso", "passkey"] satisfies SignInMethod[];
const isMethod = (v: unknown): v is SignInMethod => typeof v === "string" && METHODS.includes(v);

function local(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function tab(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The trimmed address, or "" when it does not look like one (or is absurdly long). */
function cleanEmail(email: string): string {
  const v = email.trim();
  const at = v.lastIndexOf("@");
  return at < 1 || at === v.length - 1 || v.length > 320 || /\s/.test(v) ? "" : v;
}

/** Records a sign-in that has succeeded. Does nothing if storage is blocked. */
export function rememberSignIn(method: SignInMethod, email: string): void {
  const value = cleanEmail(email);
  if (!value) return;
  try {
    local()?.setItem(KEY, JSON.stringify({ method, email: value }));
  } catch {
    // Blocked or full: the hint just does not show.
  }
}

/** The last successful sign-in, or `null` when there is none, storage is blocked or the value is bad. */
export function lastSignIn(): { method: SignInMethod; email: string } | null {
  try {
    const raw = local()?.getItem(KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { method, email } = v as Record<string, unknown>;
    if (!isMethod(method) || typeof email !== "string" || !cleanEmail(email)) return null;
    return { method, email };
  } catch {
    return null;
  }
}

/** Forgets the hint ("Not you?"). */
export function forgetSignIn(): void {
  try {
    local()?.removeItem(KEY);
  } catch {
    // A blocked store holds nothing to forget.
  }
}

/**
 * Marks a sign-in under way: the method, and for a second factor on the email code the address
 * the account row needs. Tab-only, replaced by the next mark, and recorded only if the session
 * is created.
 */
export function markPending(method: SignInMethod, email?: string): void {
  try {
    tab()?.setItem(PENDING_KEY, JSON.stringify(email ? { method, email } : { method }));
  } catch {
    // Without it a provider sign-in is simply not remembered.
  }
}

/** Drops the pending mark (and any address it holds) when its sign-in was abandoned. */
export function clearPending(): void {
  try {
    tab()?.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

function readPending(): { method: SignInMethod; email?: string } | null {
  try {
    const v: unknown = JSON.parse(tab()?.getItem(PENDING_KEY) ?? "null");
    if (typeof v !== "object" || v === null) return null;
    const { method, email } = v as Record<string, unknown>;
    if (!isMethod(method)) return null;
    return typeof email === "string" ? { method, email } : { method };
  } catch {
    return null;
  }
}

/** The cookie's value when the session still needs a second factor: no address, no record. */
export const SECOND_FACTOR_PENDING = "2fa";

/**
 * Completes a pending sign-in once the session cookie says it succeeded. While it says a second
 * factor is still to come, the hint is cleared and the pending mark kept for the factor's result.
 */
export function settlePending(): void {
  try {
    const entry = document.cookie.split("; ").find((c) => c.startsWith(`${SIGNED_IN_COOKIE}=`));
    if (!entry) return;
    // Consume the cookie whatever happens next, so the address does not linger.
    document.cookie = `${SIGNED_IN_COOKIE}=; Max-Age=0; Path=/`;
    const value = decodeURIComponent(entry.slice(SIGNED_IN_COOKIE.length + 1));
    // Any older hint would now name someone else.
    if (value === SECOND_FACTOR_PENDING) return forgetSignIn();
    const pending = readPending();
    tab()?.removeItem(PENDING_KEY);
    if (!pending) return;
    rememberSignIn(pending.method, value);
    if (pending.email && pending.method === "email") rememberAccount(pending.email, "email");
  } catch {
    // Nothing to record.
  }
}

/**
 * After the email code: a completed sign-in is remembered (account and hint). One that goes on
 * to a second factor records nothing yet and clears both so neither names someone else; it is
 * recorded as `email` when the factor completes (the exchange sets the cookie, `settlePending`
 * reads it), and stays unrecorded if the factor is abandoned.
 */
export function recordEmailSignIn(kind: "signed_in" | "2fa_required", email: string): void {
  if (kind === "signed_in") {
    rememberAccount(email, "email");
    rememberSignIn("email", email);
    return;
  }
  forgetAccount();
  forgetSignIn();
  markPending("email", email);
}
