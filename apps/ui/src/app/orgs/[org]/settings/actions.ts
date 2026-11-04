"use server";

// Server Actions of the organization settings page (#347). Each one re-checks its input (a
// Server Action is a public POST endpoint), calls the API as the signed-in user and answers a
// sentence to show, never a raw error. Authorization is the API's: `PATCH` needs owner or admin,
// `DELETE` needs owner.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { HOME_VIEW } from "@/lib/data";
import { type Org, type UpdateOrgRequest, identity, isApiError } from "@/lib/identity";
import { checkDomains, checkOrgName, deleteConfirmed, orgSettingsError } from "@/lib/org-settings";
import { orgHome } from "@/lib/scope";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type OrgActionResult = { ok: true; org: Org } | { ok: false; error: string; code?: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Where someone lands when the organization they were in is gone. */
const NO_ORG_PATH = "/onboarding/join";

function failed(err: unknown): OrgActionResult {
  if (!isApiError(err)) throw err;
  return { ok: false, error: orgSettingsError(err.code), code: err.code };
}

async function patch(slug: string, body: UpdateOrgRequest): Promise<OrgActionResult> {
  return withActionSession(async (session) => {
    try {
      const org = await session.call((o) => identity().updateOrg(slug, body, o));
      // The name also shows in the sidebar and the scope switcher.
      revalidatePath("/", "layout");
      return { ok: true, org };
    } catch (err) {
      return failed(err);
    }
  });
}

/** Renames the organization. */
export async function saveOrgName(slug: string, name: string): Promise<OrgActionResult> {
  if (typeof slug !== "string" || !SLUG.test(slug)) return { ok: false, error: orgSettingsError("not_found") };
  const checked = checkOrgName(typeof name === "string" ? name : "");
  if (!checked.ok) return { ok: false, error: checked.error };
  return patch(slug, { name: checked.name });
}

/** Replaces the allowed email domains and sets whether people with them join automatically. */
export async function saveOrgDomains(slug: string, domains: string[], domainJoin: boolean): Promise<OrgActionResult> {
  if (typeof slug !== "string" || !SLUG.test(slug)) return { ok: false, error: orgSettingsError("not_found") };
  const checked = checkDomains(domains);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (typeof domainJoin !== "boolean") return { ok: false, error: orgSettingsError("invalid_request") };
  // Joining by domain needs at least one domain to match.
  return patch(slug, { allowed_domains: checked.domains, domain_join: checked.domains.length > 0 && domainJoin });
}

async function landingAfterDelete(session: ServerSession, deleted: string): Promise<string> {
  try {
    const context = await session.call((o) => identity().context(o));
    const next = context.orgs.find((org) => org.slug !== deleted);
    return next ? orgHome(next, HOME_VIEW) : NO_ORG_PATH;
  } catch (err) {
    if (!isApiError(err)) throw err;
    return NO_ORG_PATH;
  }
}

/**
 * Deletes the organization once `confirm` repeats its slug, then sends the browser to another
 * organization (or to joining one when none is left). Answers only on failure.
 */
export async function deleteOrganization(slug: string, confirm: string): Promise<OrgActionResult> {
  if (typeof slug !== "string" || !SLUG.test(slug)) return { ok: false, error: orgSettingsError("not_found") };
  if (typeof confirm !== "string" || !deleteConfirmed(slug, confirm)) {
    return { ok: false, error: `Type ${slug} to confirm.` };
  }
  const landing = await withActionSession(async (session): Promise<OrgActionResult | string> => {
    try {
      await session.call((o) => identity().deleteOrg(slug, o));
    } catch (err) {
      return failed(err);
    }
    revalidatePath("/", "layout");
    return landingAfterDelete(session, slug);
  });
  if (typeof landing !== "string") return landing;
  redirect(landing);
}
