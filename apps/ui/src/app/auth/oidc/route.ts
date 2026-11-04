// GET /auth/oidc?request_id=…: identity's built-in OpenID provider sends the browser here to sign
// in for an OAuth/OIDC client (#301). Signed out, the user goes through the normal sign-in and
// comes back; signed in, identity binds the user to the request and the browser follows its
// callback, which hands the authorization code to the client. Public in the auth gate (`/auth`)
// so `prompt=none` can be answered without showing a sign-in.
import { type NextRequest, NextResponse } from "next/server";
import { callContext } from "@/lib/auth-routes";
import { type OidcRequest, identity, isApiError } from "@/lib/identity";
import { endWith, requestId, whenSignedOut } from "@/lib/oidc-authorize";
import { isSessionExpired, serverSession } from "@/lib/server-session";

function plain(status: number, message: string): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function redirect(req: NextRequest, location: string): NextResponse {
  const res = NextResponse.redirect(new URL(location, req.url), 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(req: NextRequest) {
  const id = requestId(req.nextUrl.searchParams.get("request_id"));
  if (!id) return plain(400, "Invalid sign-in request.");

  let request: OidcRequest;
  try {
    request = await identity().oidcRequest(id, callContext(req));
  } catch (err) {
    if (isApiError(err) && err.status === 400) {
      return plain(400, "This sign-in request has expired. Start again from the application.");
    }
    throw err;
  }

  const session = await serverSession(req);
  if (!session.payload) return redirect(req, whenSignedOut(request));
  try {
    const { redirect_to } = await session.call((o) => identity().oidcComplete(id, o));
    return session.applyTo(redirect(req, redirect_to));
  } catch (err) {
    if (isSessionExpired(err)) return session.applyTo(redirect(req, whenSignedOut(request)));
    // The client wants a more recent sign-in than this session's (max_age, prompt=login).
    if (isApiError(err) && err.code === "reauth_required") {
      return session.applyTo(redirect(req, endWith(request, "login_required")));
    }
    throw err;
  }
}
