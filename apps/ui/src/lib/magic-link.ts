// Magic-link landing (#316). The sign-in email links to `/verify?token=…&email=…`; identity's
// `GET /auth/email/link` redirects there too. The token is exchanged on the server, never in the
// browser:
//
// 1. `/verify` (a Server Component) calls {@link verifyLanding}. With no session it sends the
//    browser to `GET /api/auth/email/verify-link?token=…` ({@link exchangeUrl}); a session for the
//    same address skips the exchange (the link stays unused); a session for someone else (or an
//    unknown address) renders "You are signed in as X" with continue/switch.
// 2. That Route Handler runs {@link exchangeLink}: it posts the token to identity, seals the
//    session cookie and redirects to `next`. Server Components cannot set cookies, which is why the
//    exchange itself lives in a Route Handler rather than in the page.
// 3. `invalid_token`/`code_expired` (an unknown, used, superseded or expired link) redirect back to
//    `/verify?link=expired&email=…` ({@link problemUrl}), which renders "This link has expired or
//    was already used" with a "Send a new link" form. The token is dropped from that URL.
import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { clearPreAuthCookie, setPreAuthCookie, setSessionCookie } from "./auth-routes";
import { twoFactorPath } from "./email-verify";
import {
  CLIENT_ERROR_CODES,
  type CallOptions,
  type IdentityClient,
  type User,
  contextFromHeaders,
  identity,
  isApiError,
  isTwoFactorRequired,
} from "./identity";
import { safeNext } from "./safe-next";
import { SESSION_COOKIE_NAME, type SessionPayload, open } from "./session";

/** The Route Handler that exchanges a magic link and sets the session cookie. */
export const LINK_ROUTE = "/api/auth/email/verify-link";
/** The landing page the email links to. */
export const VERIFY_PATH = "/verify";
/** Longest token accepted (matches `POST /api/auth/email/verify-link`). */
export const MAX_TOKEN_LENGTH = 2048;
/**
 * Magic-link sessions are kept like code sign-ins: "keep me signed in" until #322 adds a
 * control for it.
 */
export const LINK_REMEMBER = true;

/** Why a link could not sign in, carried as `?link=` on `/verify`. */
export type LinkProblem = "expired" | "error";

/** Identity codes meaning "this link will never work": unknown, used, superseded or expired. */
const DEAD_LINK = new Set<string>([
  "invalid_token",
  "code_expired",
  "invalid_request",
  CLIENT_ERROR_CODES.validation,
  CLIENT_ERROR_CODES.badRequest,
]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A plausible address from the query, or undefined. Only ever used for display and prefill. */
export function linkEmail(input: unknown): string | undefined {
  const value = first(input)?.trim();
  return value && value.length <= 254 && EMAIL.test(value) ? value : undefined;
}

function first(input: unknown): string | undefined {
  if (Array.isArray(input)) return typeof input[0] === "string" ? input[0] : undefined;
  return typeof input === "string" ? input : undefined;
}

/** A usable token from the query, or undefined. */
export function linkToken(input: unknown): string | undefined {
  const value = first(input)?.trim();
  return value && value.length <= MAX_TOKEN_LENGTH ? value : undefined;
}

/** The caller's `next`, when it is a same-origin path. */
export function linkNext(input: unknown): string | undefined {
  return safeNext(first(input), "") || undefined;
}

interface LinkTarget {
  email?: string;
  next?: string;
}

/** `GET /api/auth/email/verify-link?token=…`: where the browser goes to exchange the link. */
export function exchangeUrl(token: string, target: LinkTarget = {}): string {
  const q = new URLSearchParams({ token });
  if (target.email) q.set("email", target.email);
  if (target.next) q.set("next", target.next);
  return `${LINK_ROUTE}?${q}`;
}

/** `/verify?link=<problem>`: the landing page's error state, without the token. */
export function problemUrl(problem: LinkProblem, target: LinkTarget = {}): string {
  const q = new URLSearchParams({ link: problem });
  if (target.email) q.set("email", target.email);
  if (target.next) q.set("next", target.next);
  return `${VERIFY_PATH}?${q}`;
}

// ---------------------------------------------------------------------------------------------
// The landing page

export interface VerifyQuery {
  token?: string | string[];
  email?: string | string[];
  next?: string | string[];
  link?: string | string[];
}

export type VerifyLanding =
  /** No token: the code entry page (#315). */
  | { kind: "code" }
  /** Hand the token to the exchange Route Handler. */
  | { kind: "exchange"; location: string }
  /** Already signed in as the link's address: skip the exchange. */
  | { kind: "continue"; location: string }
  /** Signed in as someone else: let the user choose. */
  | { kind: "signed_in_as"; current: string; linkEmail?: string; continueTo: string; switchTo: string }
  /** The link failed earlier; offer a new one. */
  | { kind: "problem"; problem: LinkProblem; email?: string; next?: string };

export interface LandingDeps {
  /** The decrypted session cookie, or null. */
  session: SessionPayload | null;
  /** Loads the signed-in user; only called when there is a session. */
  me: () => Promise<User>;
}

/**
 * Decides what `/verify` renders or where it redirects. Never consumes the token itself: the
 * exchange happens in the Route Handler {@link exchangeLink}.
 */
export async function verifyLanding(query: VerifyQuery, deps: LandingDeps): Promise<VerifyLanding> {
  const email = linkEmail(query.email);
  const next = linkNext(query.next);
  const token = linkToken(query.token);

  if (!token) {
    const link = first(query.link);
    if (link === "expired" || link === "error") return { kind: "problem", problem: link, email, next };
    // A `?token=` too long to be real is a dead link, not a code entry.
    if (first(query.token) !== undefined) return { kind: "problem", problem: "expired", email, next };
    return { kind: "code" };
  }

  const exchange = exchangeUrl(token, { email, next });
  if (!deps.session) return { kind: "exchange", location: exchange };

  let user: User;
  try {
    user = await deps.me();
  } catch {
    // The session cannot be used here (expired, revoked, identity down): the exchange replaces
    // it, and a failure there lands on the link's own error state.
    return { kind: "exchange", location: exchange };
  }
  const continueTo = next ?? "/";
  if (email && user.email.toLowerCase() === email.toLowerCase()) return { kind: "continue", location: continueTo };
  return { kind: "signed_in_as", current: user.email, linkEmail: email, continueTo, switchTo: exchange };
}

// ---------------------------------------------------------------------------------------------
// The exchange

function redirect(req: NextRequest, location: string): NextResponse {
  const res = NextResponse.redirect(new URL(location, req.url), 302);
  res.headers.set("Cache-Control", "no-store");
  // The token rides in this request's URL: keep it out of Referer headers.
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export interface ExchangeDeps {
  client?: IdentityClient;
}

/**
 * `GET /api/auth/email/verify-link?token=…&email=…&next=…`: signs in with the magic link and
 * redirects to `next` (the caller's, else the one the email was requested with, else `/`). A
 * session that was already in the cookie (the user chose "switch") is signed out at identity.
 */
export async function exchangeLink(req: NextRequest, deps: ExchangeDeps = {}): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const email = linkEmail(params.get("email"));
  const next = linkNext(params.get("next"));
  const token = linkToken(params.get("token"));
  if (!token) return redirect(req, problemUrl("expired", { email, next }));

  const client = deps.client ?? identity();
  const context: CallOptions = contextFromHeaders(req.headers);
  let result;
  try {
    result = await client.emailVerifyLink({ token, remember: LINK_REMEMBER }, context);
  } catch (err) {
    if (isApiError(err) && DEAD_LINK.has(err.code)) return redirect(req, problemUrl("expired", { email, next }));
    if (!isApiError(err)) console.error("magic link exchange failed", err);
    return redirect(req, problemUrl("error", { email, next }));
  }

  const previous = await open(req.cookies.get(SESSION_COOKIE_NAME)?.value);

  let res: NextResponse;
  if (isTwoFactorRequired(result)) {
    const target = next ?? safeNext(result.next);
    res = redirect(req, twoFactorPath(target));
    setPreAuthCookie(res, { token: result.pre_auth_token, remember: LINK_REMEMBER, next: target });
  } else {
    res = redirect(req, next ?? safeNext(result.next));
    try {
      await setSessionCookie(res, result, LINK_REMEMBER);
    } catch (err) {
      console.error("magic link exchange: malformed session bundle", err);
      return redirect(req, problemUrl("error", { email, next }));
    }
    clearPreAuthCookie(res);
  }

  // Switching accounts: the old session is replaced by the cookie above (or by the 2FA step);
  // revoke its refresh token so it does not linger. Best effort.
  if (previous && !isTwoFactorRequired(result)) {
    try {
      await client.logout({ refresh_token: previous.refresh }, { ...context, accessToken: previous.access });
    } catch (err) {
      console.warn("magic link exchange: previous session logout failed", err instanceof Error ? err.message : err);
    }
  }
  return res;
}
