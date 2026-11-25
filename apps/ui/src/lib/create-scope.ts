// Creating an organization or a project as the signed-in user, shared by onboarding and by the
// create pages (/organizations/new, /org/<org>/projects/new). Not a "use server" module itself:
// those may only export async functions, so each route wraps these in its own action.
//
// Someone taking the address between the check and the click answers `slug_taken` with the API's
// suggestions, shown on the field. An address the user already owns (an organization) or that is
// already a project of the organization counts as created, so pressing Create again after a failed
// save goes on instead of reporting the user's own as taken.
import { z } from "zod";
import { identity, isApiError } from "@/lib/identity";
import { type CreateOrgResult, ORG_SLUG, cleanSuggestions, createOrgError } from "@/lib/org-slug";
import { type CreateProjectResult, ENV_NAME, MAX_ENVIRONMENTS, createProjectError } from "@/lib/project-create";
import { withActionSession } from "@/lib/server-session";

// The API's rules (CreateOrgInput): a Server Action is a public POST endpoint.
const orgInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(ORG_SLUG),
});

// The API's rules (CreateProjectInput).
const projectInput = z.strictObject({
  org: z.string().regex(ORG_SLUG),
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(ORG_SLUG),
  environments: z.array(z.string().regex(ENV_NAME)).min(1).max(MAX_ENVIRONMENTS),
});

/** `POST /orgs`. */
export async function createOrg(name: string, slug: string): Promise<CreateOrgResult> {
  const parsed = orgInput.safeParse({ name, slug });
  if (!parsed.success) return { ok: false, code: "invalid_request", error: createOrgError("invalid_request") };
  const body = parsed.data;
  return withActionSession(async (session) => {
    try {
      const org = await session.call((o) => identity().createOrg(body, o));
      return { ok: true, slug: org.slug };
    } catch (err) {
      if (!isApiError(err)) throw err;
      if (err.code !== "slug_taken") return { ok: false, code: err.code, error: createOrgError(err.code) };
      const ctx = await session.call((o) => identity().context(o));
      if (ctx.orgs.some((o) => o.slug === body.slug && o.role === "owner")) return { ok: true, slug: body.slug };
      return { ok: false, code: "slug_taken", suggestions: cleanSuggestions(err.problem?.suggestions) };
    }
  });
}

/** `POST /orgs/{org}/projects`. */
export async function createProjectIn(
  org: string,
  name: string,
  slug: string,
  environments: string[],
): Promise<CreateProjectResult> {
  const parsed = projectInput.safeParse({ org, name, slug, environments });
  if (!parsed.success) return { ok: false, code: "invalid_request", error: createProjectError("invalid_request") };
  const { org: orgSlug, ...body } = parsed.data;
  body.environments = [...new Set(body.environments)];
  return withActionSession(async (session) => {
    try {
      const project = await session.call((o) => identity().createProject(orgSlug, body, o));
      return { ok: true, slug: project.slug };
    } catch (err) {
      if (!isApiError(err)) throw err;
      if (err.code !== "slug_taken") return { ok: false, code: err.code, error: createProjectError(err.code) };
      const ctx = await session.call((o) => identity().context(o));
      const org = ctx.orgs.find((o) => o.slug === orgSlug);
      if (org?.projects.some((p) => p.slug === body.slug)) return { ok: true, slug: body.slug };
      return { ok: false, code: "slug_taken", suggestions: cleanSuggestions(err.problem?.suggestions) };
    }
  });
}
