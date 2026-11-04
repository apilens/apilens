// Routing decisions for the auth gate (`src/proxy.ts`), kept free of Next and crypto so they
// can be unit tested. The proxy decrypts the session cookie (decrypt-verify, never presence:
// a stale or tampered cookie must count as signed out, or `/` redirect-loops as it did in v1)
// and hands the result here.
import { safeNext } from "./safe-next";
import type { SessionPayload } from "./session-format";

/** Where signed-out users are sent; `next` carries the page they asked for. */
export const SIGN_IN_PATH = "/sign-in";
/** First onboarding page, for a signed-in user without an organization (see `lib/landing.ts`). */
export const ONBOARDING_PATH = "/onboarding/about";

/**
 * Request header the gate sets when the access token is within {@link REFRESH_WINDOW_SECONDS}
 * of expiry (or past it). The server API client reads it to refresh before calling the backend.
 * The gate always strips any client-supplied value, so only the gate can set it.
 */
export const REFRESH_HEADER = "x-apilens-session-refresh";
/** Refresh when the access token expires within two minutes. */
export const REFRESH_WINDOW_SECONDS = 2 * 60;

/** Pages that never need a session. */
const PUBLIC_EXACT = new Set(["/sign-in", "/sign-up", "/verify"]);
/** Path prefixes (whole segments) that never need a session. */
const PUBLIC_PREFIXES = ["/auth", "/invite", "/api/auth"];
/** Signed-in users are bounced off these to `next` (or `/`). */
const GUEST_ONLY = new Set(["/sign-in", "/sign-up"]);

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Whether `pathname` is reachable without a session. `/design*` is public in development only. */
export function isPublicPath(pathname: string, dev: boolean): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (PUBLIC_PREFIXES.some((p) => underPrefix(pathname, p))) return true;
  return dev && pathname.startsWith("/design");
}

/** Whether the access token is close enough to (or past) expiry to refresh. */
export function needsRefresh(session: Pick<SessionPayload, "exp">, nowSeconds: number): boolean {
  return session.exp - nowSeconds <= REFRESH_WINDOW_SECONDS;
}

export interface GateRequest {
  pathname: string;
  /** Raw query string including the leading `?`, or "". */
  search: string;
  /** The decrypted session cookie, or null when missing, tampered or malformed. */
  session: SessionPayload | null;
  nowSeconds: number;
  dev: boolean;
}

export type GateDecision =
  | { action: "next"; refresh: boolean }
  | { action: "redirect"; location: string }
  | { action: "unauthorized" };

/** Decides what the proxy does with a request. `location` is always a same-origin path. */
export function decide(req: GateRequest): GateDecision {
  const { pathname, search, session } = req;

  if (session) {
    if (GUEST_ONLY.has(pathname)) {
      const next = new URLSearchParams(search).get("next");
      return { action: "redirect", location: safeNext(next, "/") };
    }
    // `/` itself (`app/page.tsx`) picks onboarding or the last project from the user's context.
    return { action: "next", refresh: needsRefresh(session, req.nowSeconds) };
  }

  if (isPublicPath(pathname, req.dev)) return { action: "next", refresh: false };
  // API callers get a 401 rather than an HTML sign-in page.
  if (underPrefix(pathname, "/api")) return { action: "unauthorized" };
  if (pathname === "/") return { action: "redirect", location: SIGN_IN_PATH };
  const next = safeNext(pathname + search, "");
  return {
    action: "redirect",
    location: next ? `${SIGN_IN_PATH}?${new URLSearchParams({ next })}` : SIGN_IN_PATH,
  };
}
