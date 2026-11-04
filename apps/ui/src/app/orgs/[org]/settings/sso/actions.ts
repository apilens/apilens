"use server";

// Server Actions of the organization SSO page (#348). Each one re-checks its input (a Server
// Action is a public POST endpoint), calls the API as the signed-in user and answers a sentence
// to show, never a raw error. Authorization is the API's: every SSO operation needs an owner.
import { revalidatePath } from "next/cache";
import { type SSOConnection, type SSOTestResult, identity, isApiError } from "@/lib/identity";
import { type SSOForm, checkSSOForm, issuerProblem, ssoError } from "@/lib/org-sso";
import { withActionSession } from "@/lib/server-session";

export type SSOActionResult = { ok: true; connection: SSOConnection } | { ok: false; error: string; code?: string };
export type SSODeleteResult = { ok: true } | { ok: false; error: string; code?: string };
export type SSOTestActionResult = { ok: true; result: SSOTestResult } | { ok: false; error: string; code?: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const validSlug = (slug: unknown): slug is string => typeof slug === "string" && SLUG.test(slug);
const badSlug = () => ({ ok: false as const, error: ssoError("not_found"), code: "not_found" });

function failed(err: unknown): { ok: false; error: string; code: string } {
  if (!isApiError(err)) throw err;
  return { ok: false, error: ssoError(err.code), code: err.code };
}

/** Creates or replaces the connection. An empty `clientSecret` keeps the stored one. */
export async function saveSSOConnection(slug: string, form: SSOForm, existing: boolean): Promise<SSOActionResult> {
  if (!validSlug(slug)) return badSlug();
  if (typeof form !== "object" || form === null) return { ok: false, error: ssoError("invalid_request"), code: "invalid_request" };
  const checked = checkSSOForm(form, existing === true);
  if (!checked.ok) return { ok: false, error: checked.error, code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const connection = await session.call((o) => identity().putOrgSSO(slug, checked.body, o));
      revalidatePath(`/orgs/${slug}/settings/sso`);
      return { ok: true, connection };
    } catch (err) {
      return failed(err);
    }
  });
}

/** Removes the connection; members sign in by email, social or passkey again. */
export async function deleteSSOConnection(slug: string): Promise<SSODeleteResult> {
  if (!validSlug(slug)) return badSlug();
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().deleteOrgSSO(slug, o));
    } catch (err) {
      return failed(err);
    }
    revalidatePath(`/orgs/${slug}/settings/sso`);
    return { ok: true };
  });
}

/**
 * Runs OIDC discovery on `issuer` (the one typed, which may not be saved yet) or, when it is
 * empty, on the saved connection's issuer.
 */
export async function testSSOConnection(slug: string, issuer: string): Promise<SSOTestActionResult> {
  if (!validSlug(slug)) return badSlug();
  const typed = typeof issuer === "string" ? issuer.trim() : "";
  if (typed) {
    const problem = issuerProblem(typed);
    if (problem) return { ok: false, error: problem, code: "invalid_request" };
  }
  return withActionSession(async (session) => {
    try {
      const result = await session.call((o) => identity().testOrgSSO(slug, typed || undefined, o));
      return { ok: true, result };
    } catch (err) {
      return failed(err);
    }
  });
}
