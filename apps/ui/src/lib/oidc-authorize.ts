// Routing decisions for `GET /auth/oidc?request_id=` (#301), where identity's built-in OpenID
// provider sends the browser to sign in for an OAuth/OIDC client. Kept free of Next so they can
// be unit tested; the Route Handler is `src/app/auth/oidc/route.ts`.
import { SIGN_IN_PATH } from "./auth-gate";
import type { OidcRequest } from "./identity";

/** The UI path identity's provider redirects to (`oidcprovider.LoginPath`). */
export const OIDC_LOGIN_PATH = "/auth/oidc";

/** Errors the UI may end a request with instead of signing the user in. */
export type OidcEndError = "login_required" | "access_denied" | "interaction_required";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `request_id` query value when it is a request id, else null. */
export function requestId(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

/** Identity's callback URL that answers the client with `error` instead of a code. */
export function endWith(request: Pick<OidcRequest, "callback_url">, error: OidcEndError): string {
  const url = new URL(request.callback_url);
  url.searchParams.set("error", error);
  return url.href;
}

/** The sign-in page, returning to this request afterwards. */
export function signInFor(id: string): string {
  const next = `${OIDC_LOGIN_PATH}?${new URLSearchParams({ request_id: id })}`;
  return `${SIGN_IN_PATH}?${new URLSearchParams({ next })}`;
}

/**
 * Where a signed-out browser goes: the sign-in page, unless the client asked for no
 * interaction (`prompt=none`), which ends the request with `login_required`.
 */
export function whenSignedOut(request: Pick<OidcRequest, "id" | "prompt" | "callback_url">): string {
  return request.prompt.includes("none") ? endWith(request, "login_required") : signInFor(request.id);
}
