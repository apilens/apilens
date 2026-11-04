// Server-side session client: hands server code a usable access token, refreshing it at
// identity when the proxy flagged it as near expiry (`REFRESH_HEADER`), when it has expired,
// or when the backend answered 401, and rewrites the encrypted cookie with the new pair.
//
// Refresh is coalesced per refresh token (v1 auth-refresh-herd lesson): identity rotates the
// refresh token on every use and treats a second use of the old one as theft, revoking the
// whole family. A page that fires ten parallel calls with the same cookie must therefore cause
// exactly one `POST /auth/refresh`. Calls for the same token share one in-flight promise, and a
// successful result is remembered for {@link RECENT_REFRESH_TTL_MS} so requests that arrive
// just after (still carrying the old cookie) reuse it instead of replaying the spent token.
// Both maps are keyed by the SHA-256 of the refresh token, never the token itself.
//
// Where the new cookie can be written:
// - Route Handlers: `serverSession(req)`, then `session.applyTo(res)` writes it with
//   `res.cookies.set` (`cookies().set()` does not attach to a NextResponse built by hand).
// - Server Actions: `actionSession()` writes through `cookies()` from `next/headers`.
// - Server Components cannot set cookies (rendering may already be streaming). Refreshing
//   there would rotate the refresh token without persisting the new one, and the next request
//   would replay the spent token and trip reuse detection. `componentSession()` therefore never
//   refreshes: it uses the access token while it is still valid (the proxy flags it two minutes
//   early, so it normally is) and otherwise redirects through `GET /api/auth/refresh?next=...`,
//   a Route Handler that refreshes, rewrites the cookie and sends the browser back.
//
// When identity rejects the refresh token the session is over: the cookie is cleared and the
// browser is sent to `/sign-in?reason=session_expired` ({@link SESSION_EXPIRED_PATH}).
import "server-only";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { type NextRequest, NextResponse } from "next/server";
import { REFRESH_HEADER, SIGN_IN_PATH, needsRefresh } from "./auth-gate";
import {
  type CallOptions,
  type IdentityClient,
  type SessionBundle,
  contextFromHeaders,
  identity,
  isApiError,
} from "./identity";
import { safeNext } from "./safe-next";
import { SESSION_COOKIE_NAME, type SessionPayload, open, seal, sessionCookieOptions } from "./session";

/** Where the browser goes when the session can no longer be refreshed. */
export const SESSION_EXPIRED_PATH = `${SIGN_IN_PATH}?reason=session_expired`;
/** `code` of the JSON answer to a non-navigation request whose session expired. */
export const SESSION_EXPIRED_CODE = "session_expired";
/** Route Handler Server Components redirect through to refresh (they cannot set cookies). */
export const REFRESH_ROUTE = "/api/auth/refresh";
/** How long a successful refresh is reused for requests still carrying the old token. */
export const RECENT_REFRESH_TTL_MS = 15_000;

/** The session cannot be refreshed (missing cookie, or identity rejected the refresh token). */
export class SessionExpiredError extends Error {
  constructor(message = "session expired", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionExpiredError";
  }
}

export function isSessionExpired(value: unknown): value is SessionExpiredError {
  return value instanceof SessionExpiredError;
}

// ---------------------------------------------------------------------------------------------
// Coalesced refresh

interface Recent {
  at: number;
  bundle: SessionBundle;
}

const inflight = new Map<string, Promise<SessionBundle>>();
const recent = new Map<string, Recent>();

/** Map key for a refresh token: its SHA-256, so the token itself is never held as a key. */
export function refreshKey(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("base64url");
}

function pruneRecent(now: number): void {
  for (const [key, entry] of recent) {
    if (now - entry.at >= RECENT_REFRESH_TTL_MS) recent.delete(key);
  }
}

export interface RefreshDeps {
  client?: IdentityClient;
  now?: () => number;
}

/**
 * Exchanges `refreshToken` for a new session bundle, at most once per token: concurrent callers
 * share the in-flight call and callers within {@link RECENT_REFRESH_TTL_MS} of a success reuse
 * its result. Failures are not cached (a transient one may be retried); concurrent callers do
 * share the failure.
 */
export function refreshOnce(
  refreshToken: string,
  context: CallOptions = {},
  deps: RefreshDeps = {},
): Promise<SessionBundle> {
  const now = deps.now ?? Date.now;
  const key = refreshKey(refreshToken);
  pruneRecent(now());
  const hit = recent.get(key);
  if (hit) return Promise.resolve(hit.bundle);
  const pending = inflight.get(key);
  if (pending) return pending;

  const client = deps.client ?? identity();
  const call = client
    .refresh({ refresh_token: refreshToken }, context)
    .then((bundle) => {
      recent.set(key, { at: now(), bundle });
      return bundle;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, call);
  return call;
}

/** Forgets every in-flight and recent refresh. Tests only. */
export function resetRefreshCache(): void {
  inflight.clear();
  recent.clear();
}

/**
 * Whether a failed refresh means the session is over (identity rejected the token) rather than
 * a transient failure (network, timeout, 5xx, rate limit) worth surfacing as-is.
 */
function isRejected(err: unknown): boolean {
  return isApiError(err) && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

// ---------------------------------------------------------------------------------------------
// Session

/** What happened to the cookie during this request. */
export type CookieChange = { kind: "none" } | { kind: "set"; value: string; remember: boolean } | { kind: "clear" };

type Authed = CallOptions & { accessToken: string };

export interface ServerSessionInit {
  /** The decrypted session cookie, or null. */
  session: SessionPayload | null;
  /** Incoming request headers (refresh hint, forwarded IP/UA, request id). */
  headers: Headers;
  /** Whether a refreshed session can be persisted. False in Server Components. */
  canWrite: boolean;
  /** Persists a cookie change as soon as it happens (Server Actions); optional. */
  onChange?: (change: CookieChange) => void | Promise<void>;
  deps?: RefreshDeps;
}

/**
 * One request's view of the session. Use {@link ServerSession.call} for every authenticated
 * backend call: it refreshes first when needed and retries once after a 401.
 */
export class ServerSession {
  private session: SessionPayload | null;
  private readonly headers: Headers;
  private readonly canWrite: boolean;
  private readonly onChange?: ServerSessionInit["onChange"];
  private readonly deps: RefreshDeps;
  private hinted: boolean;
  private refreshed = false;
  private change: CookieChange = { kind: "none" };

  constructor(init: ServerSessionInit) {
    this.session = init.session;
    this.headers = init.headers;
    this.canWrite = init.canWrite;
    this.onChange = init.onChange;
    this.deps = init.deps ?? {};
    this.hinted = init.headers.get(REFRESH_HEADER) === "1";
  }

  /** The current session payload (after any refresh), or null when signed out. */
  get payload(): SessionPayload | null {
    return this.session;
  }

  /** The pending cookie change for {@link ServerSession.applyTo}. */
  get cookieChange(): CookieChange {
    return this.change;
  }

  private nowSeconds(): number {
    return Math.floor((this.deps.now ?? Date.now)() / 1000);
  }

  private context(): CallOptions {
    return contextFromHeaders(this.headers);
  }

  private async record(change: CookieChange): Promise<void> {
    this.change = change;
    await this.onChange?.(change);
  }

  private async expire(cause?: unknown): Promise<never> {
    this.session = null;
    if (this.canWrite) await this.record({ kind: "clear" });
    throw new SessionExpiredError("session expired", cause === undefined ? undefined : { cause });
  }

  /** Refreshes now (coalesced). Throws SessionExpiredError when identity rejects the token. */
  async refresh(): Promise<SessionPayload> {
    const current = this.session;
    if (!current) return this.expire();
    if (!this.canWrite) {
      // Rotating without persisting would replay the spent token on the next request.
      throw new SessionExpiredError("cannot refresh where cookies are read-only");
    }
    let bundle: SessionBundle;
    try {
      bundle = await refreshOnce(current.refresh, this.context(), this.deps);
    } catch (err) {
      if (isRejected(err)) return this.expire(err);
      throw err;
    }
    const next: SessionPayload = {
      access: bundle.access_token,
      refresh: bundle.refresh_token,
      exp: this.nowSeconds() + Math.max(0, Math.floor(bundle.expires_in)),
      remember: current.remember,
      uid: bundle.user?.id || current.uid,
    };
    this.session = next;
    this.refreshed = true;
    this.hinted = false;
    await this.record({ kind: "set", value: await seal(next), remember: next.remember });
    return next;
  }

  /**
   * A usable access token: refreshes first when the proxy flagged the session or the token is
   * near expiry. A transient refresh failure falls back to the current token while it is valid.
   */
  async accessToken(): Promise<string> {
    const current = this.session;
    if (!current) return this.expire();
    const now = this.nowSeconds();
    if (this.refreshed || !(this.hinted || needsRefresh(current, now))) return current.access;
    if (!this.canWrite) {
      if (current.exp > now) return current.access;
      throw new SessionExpiredError("access token expired where cookies are read-only");
    }
    try {
      return (await this.refresh()).access;
    } catch (err) {
      if (!isSessionExpired(err) && current.exp > now) return current.access;
      throw err;
    }
  }

  /**
   * Runs an authenticated backend call with the browser's context. On a 401 it refreshes once
   * (coalesced with every other request holding the same token) and retries.
   */
  async call<T>(fn: (options: Authed) => Promise<T>): Promise<T> {
    const accessToken = await this.accessToken();
    try {
      return await fn({ ...this.context(), accessToken });
    } catch (err) {
      if (!isApiError(err) || err.status !== 401 || this.refreshed) throw err;
      if (!this.canWrite) throw new SessionExpiredError("access token rejected", { cause: err });
      const fresh = await this.refresh();
      return fn({ ...this.context(), accessToken: fresh.access });
    }
  }

  /** Writes the refreshed (or cleared) cookie onto a Route Handler response. */
  applyTo<R extends NextResponse>(res: R): R {
    const change = this.change;
    if (change.kind === "set") {
      res.cookies.set(SESSION_COOKIE_NAME, change.value, sessionCookieOptions(change.remember));
    } else if (change.kind === "clear") {
      res.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(false), maxAge: 0 });
    }
    return res;
  }
}

// ---------------------------------------------------------------------------------------------
// Entry points

/** The session of a Route Handler request. Call `applyTo(res)` on whatever it returns. */
export async function serverSession(req: NextRequest, deps?: RefreshDeps): Promise<ServerSession> {
  const session = await open(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  return new ServerSession({ session, headers: req.headers, canWrite: true, deps });
}

/**
 * The Route Handler answer for an expired session: the cookie is cleared, browser navigations
 * are redirected to {@link SESSION_EXPIRED_PATH} and fetches get `401 {ok: false, code, next}`.
 */
export function sessionExpiredResponse(
  req: NextRequest,
  navigation = (req.headers.get("accept") ?? "").includes("text/html"),
): NextResponse {
  const res = navigation
    ? NextResponse.redirect(new URL(SESSION_EXPIRED_PATH, req.url), 302)
    : NextResponse.json(
        { ok: false, code: SESSION_EXPIRED_CODE, next: SESSION_EXPIRED_PATH },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
  res.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(false), maxAge: 0 });
  return res;
}

/**
 * Wraps a Route Handler body: provides the session, writes any refreshed cookie on the
 * response, and turns an expired session into {@link sessionExpiredResponse}.
 */
export async function withSession(
  req: NextRequest,
  handler: (session: ServerSession) => Promise<NextResponse>,
  deps?: RefreshDeps,
): Promise<NextResponse> {
  const session = await serverSession(req, deps);
  try {
    return session.applyTo(await handler(session));
  } catch (err) {
    if (isSessionExpired(err)) return sessionExpiredResponse(req);
    throw err;
  }
}

/** The refresh route's URL that returns to `next` (a same-origin path) afterwards. */
export function refreshUrl(next: string): string {
  return `${REFRESH_ROUTE}?${new URLSearchParams({ next: safeNext(next) })}`;
}

/**
 * The session of a Server Action. A refresh is written straight through `cookies()`; on an
 * expired session the cookie is deleted and the action redirects to the sign-in page.
 */
export async function actionSession(deps?: RefreshDeps): Promise<ServerSession> {
  const jar = await cookies();
  const session = await open(jar.get(SESSION_COOKIE_NAME)?.value);
  return new ServerSession({
    session,
    headers: new Headers(await headers()),
    canWrite: true,
    deps,
    onChange: (change) => {
      if (change.kind === "set") {
        jar.set(SESSION_COOKIE_NAME, change.value, sessionCookieOptions(change.remember));
      } else if (change.kind === "clear") {
        jar.delete(SESSION_COOKIE_NAME);
      }
    },
  });
}

/**
 * The read-only session of a Server Component (see the module comment). Never refreshes; a
 * `SessionExpiredError` from it means "send the browser through {@link refreshUrl}", which
 * {@link redirectToRefresh} does.
 */
export async function componentSession(): Promise<ServerSession> {
  const session = await open((await cookies()).get(SESSION_COOKIE_NAME)?.value);
  return new ServerSession({ session, headers: new Headers(await headers()), canWrite: false });
}

/** Redirects a Server Component through the refresh route back to `next`. */
export function redirectToRefresh(next: string): never {
  redirect(refreshUrl(next));
}

/**
 * Wraps a Server Action body: provides the session and, when it has expired (cookie already
 * deleted), redirects to {@link SESSION_EXPIRED_PATH}.
 */
export async function withActionSession<T>(fn: (session: ServerSession) => Promise<T>, deps?: RefreshDeps): Promise<T> {
  const session = await actionSession(deps);
  try {
    return await fn(session);
  } catch (err) {
    if (isSessionExpired(err)) redirect(SESSION_EXPIRED_PATH);
    throw err;
  }
}
