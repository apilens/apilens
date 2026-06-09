import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie } from "@/lib/session-edge";

const COOKIE_NAME = "apilens_session";
const PUBLIC_PATHS = ["/auth/login", "/auth/signup", "/auth/verify", "/auth/reset-password", "/auth/recovery", "/api/auth/"];
const AUTH_PAGES = ["/auth/login", "/auth/signup", "/auth/verify", "/auth/reset-password", "/auth/recovery"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cookie = request.cookies.get(COOKIE_NAME);
  // Decrypt-verify the cookie so "has session" means "valid session" — the
  // same check Server Components make via getSession(). Trusting mere cookie
  // presence here while pages validate the contents causes a redirect loop
  // (ERR_TOO_MANY_REDIRECTS) for any stale/undecryptable cookie.
  const isAuthed = await verifySessionCookie(cookie?.value);

  // Logged-in users hitting auth pages → redirect to home
  if (isAuthed && AUTH_PAGES.some((p) => pathname.startsWith(p))) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Not logged in + not an API route → redirect to login.
  // Drop any stale/invalid cookie on the way out so we don't bounce again.
  if (!isAuthed && !pathname.startsWith("/api/")) {
    const res = NextResponse.redirect(new URL("/auth/login", request.url));
    if (cookie) res.cookies.delete(COOKIE_NAME);
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
