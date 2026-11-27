// Which optional sign-in buttons the sign-in and sign-up pages show (#312). Email code is
// always offered; Google, GitHub and SSO follow `GET /api/v1/auth/providers`, so a self-host
// without OAuth keys never renders a button that cannot work.
//
// Client-safe: the Client Components import this. The server-side loader lives in
// `sign-in-providers.ts`.
import type { AuthProviders } from "./identity";

/** The optional methods, as passed from the page (Server Component) into `SignIn`/`SignUp`. */
export interface SignInMethods {
  google: boolean;
  github: boolean;
  sso: boolean;
}

/** Used when the providers call fails: email code works on every deployment. */
export const EMAIL_ONLY: SignInMethods = { google: false, github: false, sso: false };

/** Narrows the providers response to the optional methods, treating anything but `true` as off. */
export function toSignInMethods(p: Partial<AuthProviders> | null | undefined): SignInMethods {
  return { google: p?.google === true, github: p?.github === true, sso: p?.sso === true };
}

export type AltMethod = "email" | "github" | "google" | "sso";

export type OAuthProvider = "google" | "github";

/**
 * Where each provider button navigates (identity's OAuth start URL, built on the server by
 * `oauthStartLinks` in `oauth.ts`), present only for the providers this deployment enables.
 */
export type OAuthLinks = Partial<Record<OAuthProvider, string>>;

/**
 * The provider buttons in display order. `email` leads when the row carries the email code.
 *
 * Google and GitHub are deliberately absent: the product offers a passkey, SSO and an emailed
 * code, so no third party learns who signs in. `SignInMethods` still carries their flags because
 * `GET /api/v1/auth/providers` still reports them and the OAuth routes still answer.
 */
export function altMethods(m: SignInMethods, opts: { email: boolean }): AltMethod[] {
  const out: AltMethod[] = opts.email ? ["email"] : [];
  if (m.sso) out.push("sso");
  return out;
}
