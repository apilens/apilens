// Shared plumbing for the Route Handlers under `src/app/api/auth/*`. They are the only place
// the browser talks to for sign-in: each one validates its JSON input, calls identity on the
// server (forwarding the browser's `X-Forwarded-For` and `User-Agent`), seals the session into
// the encrypted cookie and answers with `{ok, next}` or `{ok: false, code}`.
//
// Tokens never reach the browser: neither the access/refresh pair nor a 2FA `pre_auth_token`
// is ever written to a response body. The pre-auth token waits in its own short-lived httpOnly
// cookie, scoped to `/api/auth/2fa`, until `POST /api/auth/2fa/exchange` spends it.
//
// Cookies are set with `res.cookies.set()` on the returned NextResponse: `cookies().set()` from
// `next/headers` does not attach to a NextResponse built here (v1 lesson).
import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { SIGN_IN_PATH } from "./auth-gate";
import { env } from "./env";
import {
  CLIENT_ERROR_CODES,
  type CallOptions,
  type SessionBundle,
  type SignInResult,
  contextFromHeaders,
  isApiError,
  isTwoFactorRequired,
} from "./identity";
import { safeNext } from "./safe-next";
import { SESSION_COOKIE_NAME, seal, sessionCookieOptions } from "./session";
import { fromBase64Url, toBase64Url } from "./session-format";

/** httpOnly cookie holding a pending 2FA `pre_auth_token` (plus `remember` and `next`). */
export const PRE_AUTH_COOKIE_NAME = "apilens_preauth";
/** Only the exchange route needs the pre-auth cookie. */
export const PRE_AUTH_COOKIE_PATH = "/api/auth/2fa";
/** Seconds a pending 2FA sign-in stays usable in this browser. */
export const PRE_AUTH_MAX_AGE = 5 * 60;

/** `code` of a first-factor success that still needs a second factor. */
export const TWO_FACTOR_REQUIRED = "2fa_required";

/** Codes the Route Handlers assign themselves (input and transport problems). */
export const ROUTE_ERROR_CODES = {
  badRequest: CLIENT_ERROR_CODES.badRequest,
  validation: CLIENT_ERROR_CODES.validation,
  forbidden: CLIENT_ERROR_CODES.forbidden,
  unsupportedMediaType: "unsupported_media_type",
  preAuthMissing: "2fa_session_expired",
  server: CLIENT_ERROR_CODES.server,
  unavailable: CLIENT_ERROR_CODES.unavailable,
  timeout: CLIENT_ERROR_CODES.timeout,
} as const;

/** Largest JSON body accepted (a passkey assertion is the biggest input, well under this). */
const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------------
// Responses

export type AuthRouteBody =
  | { ok: true; next: string; [extra: string]: unknown }
  | { ok: false; code: string; next?: string; retry_after?: number; start_url?: string };

/** A failure answer: `{ok: false, code}` with the HTTP status (and `Retry-After` when known). */
export function failure(status: number, code: string, retryAfter?: number | null): NextResponse {
  const body: AuthRouteBody = { ok: false, code };
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (retryAfter != null) {
    body.retry_after = retryAfter;
    headers.set("Retry-After", String(retryAfter));
  }
  return NextResponse.json(body, { status, headers });
}

/** A success answer. `extra` must never carry a token. */
export function success(next: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ...extra, ok: true, next } satisfies AuthRouteBody, {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Maps anything thrown by a handler to a failure answer; identity's `code` passes through. */
export function fromError(err: unknown): NextResponse {
  if (err instanceof InputError) return failure(err.status, err.code);
  if (isApiError(err)) {
    if (err.status === 0) {
      const timedOut = err.code === CLIENT_ERROR_CODES.timeout;
      return failure(timedOut ? 504 : 502, err.code);
    }
    return failure(err.status, err.code, err.retryAfter);
  }
  console.error("auth route failed", err);
  return failure(500, ROUTE_ERROR_CODES.server);
}

// ---------------------------------------------------------------------------------------------
// Input

/** Invalid browser input; answered as `{ok: false, code}` with `status`. */
export class InputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "InputError";
    this.status = status;
    this.code = code;
  }
}

const invalid = (field: string) => new InputError(422, ROUTE_ERROR_CODES.validation, `invalid ${field}`);

/**
 * Rejects cross-origin calls. Browsers send `Origin` on every cross-origin and every non-GET
 * fetch; a value that is not the configured public origin is another site posting here.
 */
function checkOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (origin === null) return;
  if (origin !== new URL(env().publicUrl).origin) {
    throw new InputError(403, ROUTE_ERROR_CODES.forbidden, "cross-origin request");
  }
}

/**
 * Reads a JSON object body. Requiring `application/json` also forces a CORS preflight for any
 * cross-site caller, so a plain HTML form on another site cannot post here.
 */
export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  checkOrigin(req);
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new InputError(415, ROUTE_ERROR_CODES.unsupportedMediaType);
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new InputError(413, ROUTE_ERROR_CODES.badRequest, "body too large");
  let body: unknown;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new InputError(400, ROUTE_ERROR_CODES.badRequest, "malformed JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InputError(400, ROUTE_ERROR_CODES.badRequest, "body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Same-origin checks for a bodyless call (logout). */
export function checkRequest(req: NextRequest): void {
  checkOrigin(req);
}

/** A required non-empty string of at most `max` characters (trimmed). */
export function requiredString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== "string") throw invalid(field);
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) throw invalid(field);
  return trimmed;
}

/** An optional string; `undefined` when absent or null. */
export function optionalString(body: Record<string, unknown>, field: string, max: number): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredString(body, field, max);
}

/** An optional string restricted to `allowed`; `fallback` when absent. */
export function optionalEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw invalid(field);
  return value as T;
}

/** A required JSON object (a WebAuthn credential). */
export function requiredObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(field);
  return value as Record<string, unknown>;
}

/** An optional boolean, `false` when absent. */
export function optionalBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw invalid(field);
  return value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A plausible email address (identity does the real validation). */
export function email(body: Record<string, unknown>, field = "email"): string {
  const value = requiredString(body, field, 254);
  if (!EMAIL.test(value)) throw invalid(field);
  return value;
}

/** The `next` the caller asked for: a same-origin path, or undefined (never an open redirect). */
export function requestedNext(body: Record<string, unknown>): string | undefined {
  const value = body.next;
  if (typeof value !== "string") return undefined;
  const safe = safeNext(value, "");
  return safe === "" ? undefined : safe;
}

/** Identity call context: the browser's IP chain, user agent and request id. */
export function callContext(req: NextRequest): CallOptions {
  return contextFromHeaders(req.headers);
}

// ---------------------------------------------------------------------------------------------
// Sessions

/** Seals a session bundle into the cookie on `res`. Throws on a malformed bundle. */
export async function setSessionCookie(
  res: NextResponse,
  bundle: SessionBundle,
  remember: boolean,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const value = await seal({
    access: bundle.access_token,
    refresh: bundle.refresh_token,
    exp: nowSeconds + Math.max(0, Math.floor(bundle.expires_in)),
    remember,
    uid: bundle.user?.id,
  });
  res.cookies.set(SESSION_COOKIE_NAME, value, sessionCookieOptions(remember));
}

/** Expires the session cookie on `res`. */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(false), maxAge: 0 });
}

interface PreAuth {
  token: string;
  remember: boolean;
  next: string;
}

export function setPreAuthCookie(res: NextResponse, pre: PreAuth): void {
  const value = toBase64Url(new TextEncoder().encode(JSON.stringify({ t: pre.token, r: pre.remember, n: pre.next })));
  res.cookies.set(PRE_AUTH_COOKIE_NAME, value, {
    ...sessionCookieOptions(pre.remember),
    path: PRE_AUTH_COOKIE_PATH,
    maxAge: PRE_AUTH_MAX_AGE,
  });
}

/** Expires the pre-auth cookie on `res`. */
export function clearPreAuthCookie(res: NextResponse): void {
  res.cookies.set(PRE_AUTH_COOKIE_NAME, "", {
    ...sessionCookieOptions(false),
    path: PRE_AUTH_COOKIE_PATH,
    maxAge: 0,
  });
}

/** Reads the pending 2FA sign-in from the request, or null when missing or malformed. */
export function readPreAuth(req: NextRequest): PreAuth | null {
  const raw = req.cookies.get(PRE_AUTH_COOKIE_NAME)?.value;
  if (!raw) return null;
  const bytes = fromBase64Url(raw);
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (typeof v.t !== "string" || v.t === "" || typeof v.r !== "boolean") return null;
    return { token: v.t, remember: v.r, next: safeNext(v.n) };
  } catch {
    return null;
  }
}

/**
 * Turns a session bundle into the success answer: seals the cookie, clears any pending 2FA
 * cookie and points the browser at `next` (the caller's, else identity's, else `/`).
 */
export async function signedIn(
  bundle: SessionBundle,
  remember: boolean,
  next: string | undefined,
): Promise<NextResponse> {
  const res = success(next ?? safeNext(bundle.next));
  await setSessionCookie(res, bundle, remember);
  clearPreAuthCookie(res);
  return res;
}

/**
 * Finishes a first-factor sign-in: a full session sets the cookie; a 2FA challenge parks the
 * pre-auth token in its httpOnly cookie and answers `{ok: false, code: "2fa_required", next}`.
 */
export async function finishSignIn(
  result: SignInResult,
  remember: boolean,
  next: string | undefined,
): Promise<NextResponse> {
  if (isTwoFactorRequired(result)) {
    const target = next ?? safeNext(result.next);
    const res = NextResponse.json({ ok: false, code: TWO_FACTOR_REQUIRED, next: target } satisfies AuthRouteBody, {
      headers: { "Cache-Control": "no-store" },
    });
    setPreAuthCookie(res, { token: result.pre_auth_token, remember, next: target });
    return res;
  }
  return signedIn(result, remember, next);
}

/** Where the browser goes after signing out; the sign-in page shows a "signed out" notice. */
export const SIGNED_OUT_PATH = `${SIGN_IN_PATH}?reason=signed_out`;
