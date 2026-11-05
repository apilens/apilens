// GET /api/auth/refresh?next=<path>: refreshes the session and sends the browser back to `next`.
// Server Components cannot set cookies, so when their access token has expired (or the backend
// rejects it) they redirect here (`redirectToRefresh`). The refresh is coalesced per refresh
// token, so a burst of such redirects still makes a single identity call. A rejected refresh
// token clears the cookie and lands on `/sign-in?reason=session_expired`.
import { type NextRequest, NextResponse } from "next/server";
import { safeNext } from "@/lib/safe-next";
import { isSessionExpired, serverSession, sessionExpiredResponse } from "@/lib/server-session";
import { redirectTo } from "@/lib/redirect";

export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get("next"), "/");
  const session = await serverSession(req);
  try {
    await session.refresh();
  } catch (err) {
    if (isSessionExpired(err)) return sessionExpiredResponse(req, true);
    // Transient failure (identity unreachable, 5xx, rate limit). Redirecting back would loop
    // (the page would send the browser straight here again), so answer 503 and keep the cookie.
    console.warn("session refresh failed", err instanceof Error ? err.message : err);
    return new NextResponse("Sign-in service temporarily unavailable. Try again shortly.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" },
    });
  }
  const res = redirectTo(next, req.url);
  res.headers.set("Cache-Control", "no-store");
  return session.applyTo(res);
}
