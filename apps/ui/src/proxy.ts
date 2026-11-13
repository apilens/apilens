// Auth gate (Next 16 `proxy`, formerly middleware). Decrypts the session cookie on every
// matched request: a cookie that is merely present but stale, tampered or malformed counts as
// signed out. Routing rules live in `lib/auth-gate.ts`.
import { type NextRequest, NextResponse } from "next/server";
import { REFRESH_HEADER, decide } from "./lib/auth-gate";
import { PATH_HEADER } from "./lib/project-redirect";
import { SESSION_COOKIE_NAME, open } from "./lib/session-edge";

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = cookie ? await open(cookie) : null;

  const decision = decide({
    pathname,
    search,
    session,
    nowSeconds: Math.floor(Date.now() / 1000),
    dev: process.env.NODE_ENV === "development",
  });

  let response: NextResponse;
  if (decision.action === "redirect") {
    // 302 (not Next's default 307): the target is always fetched with GET.
    response = NextResponse.redirect(new URL(decision.location, request.url), 302);
  } else if (decision.action === "unauthorized") {
    response = NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  } else {
    // Only the gate may set the refresh hint: drop any client-supplied copy.
    const headers = new Headers(request.headers);
    headers.delete(REFRESH_HEADER);
    if (decision.refresh) headers.set(REFRESH_HEADER, "1");
    // The path for `[project]/layout.tsx`, which redirects a renamed project's old slug (#821).
    const query = new URLSearchParams(search);
    query.delete("_rsc");
    headers.set(PATH_HEADER, query.size > 0 ? `${pathname}?${query}` : pathname);
    response = NextResponse.next({ request: { headers } });
  }

  // A cookie that failed to open is useless; clear it so the browser stops sending it.
  if (cookie && !session) response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and static files (any path with a file extension).
    "/((?!_next/static|_next/image|favicon.ico|.*\\.[A-Za-z0-9]+$).*)",
  ],
};
