// Social sign-in (Google, GitHub) from the UI's side (#317).
//
// 1. The sign-in and sign-up pages (Server Components) render the buttons as plain links to
//    identity's `GET {APILENS_PUBLIC_API_URL}/api/v1/auth/oauth/{provider}/start?next=…&intent=…`
//    ({@link oauthStartLinks}). Built on the server so the URL is right for each environment.
// 2. Identity sends the browser to the provider and, after its callback, back to
//    `/auth/callback?code=…` with a one-time handoff code (or to `/sign-in?error=<code>`).
// 3. The `/auth/callback` Route Handler runs {@link exchangeHandoff}: it redeems the code at
//    identity (`POST /auth/handoff`) on the server, seals the session cookie and redirects to the
//    sign-in's `next` (identity points a new user at onboarding), or parks the 2FA challenge in the
//    pre-auth cookie and goes to the two-factor step. Tokens never appear in a URL or a body.
import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { SIGN_IN_PATH } from "./auth-gate";
import { clearPreAuthCookie, setPreAuthCookie, setSessionCookie } from "./auth-routes";
import { twoFactorPath } from "./email-verify";
import { env } from "./env";
import {
  type CallOptions,
  type IdentityClient,
  type SignInResult,
  contextFromHeaders,
  identity,
  isApiError,
  isTwoFactorRequired,
} from "./identity";
import { safeNext } from "./safe-next";
import { SESSION_COOKIE_NAME, open } from "./session";
import type { OAuthLinks, OAuthProvider, SignInMethods } from "./sign-in-methods";
import { redirectTo } from "@/lib/redirect";

/** The page identity redirects to with the handoff code. */
export const CALLBACK_PATH = "/auth/callback";

/**
 * Social sign-ins open straight into a session with no form to ask on, so they take the default
 * of the "keep me signed in" control on the code page (#322), like a magic link: a 30-day session
 * (identity reads `remember` from the start URL) and a matching cookie.
 */
export const OAUTH_REMEMBER = true;

/** Longest handoff code accepted (matches `POST /api/auth/handoff`). */
const MAX_CODE_LENGTH = 2048;

/** `?error=` values passed through to the sign-in page; anything else becomes the generic one. */
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

/** Identity's code for a handoff that is unknown, expired or already used. */
const DEAD_CODE = "invalid_token";

/** What a failed redirect to `/sign-in` says when identity's code cannot be used (as identity's callback does). */
const FALLBACK_ERROR = "internal_error";

/**
 * `GET {apiBase}/api/v1/auth/oauth/{provider}/start?…`: where a provider button navigates.
 * `next` is dropped unless it is a same-origin path (identity checks it again).
 */
export function oauthStartUrl(apiBase: string, provider: OAuthProvider, opts: { next?: string } = {}): string {
  const q = new URLSearchParams();
  const next = safeNext(opts.next, "");
  if (next) q.set("next", next);
  q.set("intent", "login");
  q.set("remember", String(OAUTH_REMEMBER));
  return `${apiBase.replace(/\/+$/, "")}/api/v1/auth/oauth/${provider}/start?${q}`;
}

/** The start links for the enabled providers, on this environment's public API URL. */
export function oauthStartLinks(methods: SignInMethods, next?: string, apiBase?: string): OAuthLinks {
  const links: OAuthLinks = {};
  const providers = (["google", "github"] as const).filter((p) => methods[p]);
  if (providers.length === 0) return links;
  const base = apiBase ?? env().publicApiUrl;
  for (const p of providers) links[p] = oauthStartUrl(base, p, { next });
  return links;
}

/** `/sign-in?error=<code>`, with an unusable code replaced by a generic one. */
export function signInErrorPath(code: string | null | undefined): string {
  const safe = code && ERROR_CODE.test(code) ? code : FALLBACK_ERROR;
  return `${SIGN_IN_PATH}?${new URLSearchParams({ error: safe })}`;
}

function redirect(req: NextRequest, location: string): NextResponse {
  const res = redirectTo(location, req.url);
  res.headers.set("Cache-Control", "no-store");
  // The handoff code rides in this request's URL: keep it out of Referer headers.
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export interface HandoffDeps {
  client?: IdentityClient;
}

/**
 * `GET /auth/callback?code=…` (or `?error=<code>`): redeems the handoff code identity issued after
 * a Google/GitHub sign-in and redirects to `next`, the two-factor step, or `/sign-in?error=…`.
 * A session already in the cookie is replaced, and revoked at identity (best effort).
 */
export async function exchangeHandoff(req: NextRequest, deps: HandoffDeps = {}): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const error = params.get("error");
  if (error !== null) return redirect(req, signInErrorPath(error));

  const code = params.get("code")?.trim();
  if (!code || code.length > MAX_CODE_LENGTH) return redirect(req, signInErrorPath(DEAD_CODE));

  const client = deps.client ?? identity();
  const context: CallOptions = contextFromHeaders(req.headers);
  let result: SignInResult;
  try {
    result = await client.handoff({ code }, context);
  } catch (err) {
    if (!isApiError(err)) console.error("oauth handoff failed", err);
    return redirect(req, signInErrorPath(isApiError(err) && err.status !== 0 ? err.code : FALLBACK_ERROR));
  }

  if (isTwoFactorRequired(result)) {
    const target = safeNext(result.next);
    const res = redirect(req, twoFactorPath(target));
    setPreAuthCookie(res, { token: result.pre_auth_token, remember: OAUTH_REMEMBER, next: target });
    return res;
  }

  const previous = await open(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  const res = redirect(req, safeNext(result.next));
  try {
    await setSessionCookie(res, result, OAUTH_REMEMBER);
  } catch (err) {
    console.error("oauth handoff: malformed session bundle", err);
    return redirect(req, signInErrorPath(FALLBACK_ERROR));
  }
  clearPreAuthCookie(res);

  if (previous) {
    try {
      await client.logout({ refresh_token: previous.refresh }, { ...context, accessToken: previous.access });
    } catch (err) {
      console.warn("oauth handoff: previous session logout failed", err instanceof Error ? err.message : err);
    }
  }
  return res;
}
