import { NextResponse } from "next/server";

/**
 * A redirect from a route handler. Same-site paths ("/acme/explore?x=1") go out as a RELATIVE
 * `Location`, so the browser stays on the host it is already on. Building an absolute URL from
 * `req.url` is wrong behind Docker/standalone Next: `req.url` carries the bind address
 * (`http://0.0.0.0:3000`), the browser follows it to a host its session cookie (set for
 * `localhost` or the public domain) does not cover, and lands back on /sign-in.
 * Anything else (an absolute URL, or a protocol-relative "//host") is resolved against `base`.
 */
export function redirectTo(location: string, base: string | URL, status = 302): NextResponse {
  const sameSitePath = location.startsWith("/") && !location.startsWith("//") && !location.startsWith("/\\");
  if (!sameSitePath) return NextResponse.redirect(new URL(location, base), status);
  return new NextResponse(null, { status, headers: { Location: location } });
}
