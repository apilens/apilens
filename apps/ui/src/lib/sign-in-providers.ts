// Server-side loader for the sign-in methods (#312): the sign-in and sign-up pages call it and
// pass the result into the Client Components, so the buttons are right in the first HTML and
// never shift after hydration.
import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { contextFromHeaders, identity } from "./identity";
import { EMAIL_ONLY, type SignInMethods, toSignInMethods } from "./sign-in-methods";

/**
 * Fetches `GET /auth/providers` at most once per request. Falls back to email code only when
 * the backend is unreachable or misconfigured: hiding a working button beats showing a broken one.
 */
export const signInMethods = cache(async (): Promise<SignInMethods> => {
  // Outside the try: reading headers is what makes the pages render per request, and Next
  // signals that with a throw that must not be swallowed (else the build prerenders a stale list).
  const ctx = contextFromHeaders(await headers());
  try {
    const providers = await identity().providers(ctx);
    return toSignInMethods(providers);
  } catch (err) {
    console.warn("auth providers unavailable, showing email code only", err);
    return EMAIL_ONLY;
  }
});
