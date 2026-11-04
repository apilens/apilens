"use server";

// "Create project" on the onboarding project step (#331): `POST /orgs/{org}/projects` as the
// signed-in user. Someone taking the address between the check and the click answers
// `slug_taken` with the API's suggestions, shown on the field. An address that is already a
// project of this organization counts as created, so pressing Create again after a failed
// progress save (or coming back to this screen) goes on instead of reporting it as taken.
import { z } from "zod";
import { identity, isApiError } from "@/lib/identity";
import { ORG_SLUG, cleanSuggestions } from "@/lib/org-slug";
import { type CreateProjectResult, ENV_NAME, MAX_ENVIRONMENTS, createProjectError } from "@/lib/project-create";
import { withActionSession } from "@/lib/server-session";

// The API's rules (CreateProjectInput): a Server Action is a public POST endpoint.
const input = z.strictObject({
  org: z.string().regex(ORG_SLUG),
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(ORG_SLUG),
  environments: z.array(z.string().regex(ENV_NAME)).min(1).max(MAX_ENVIRONMENTS),
});

export async function createProject(org: string, name: string, slug: string, environments: string[]): Promise<CreateProjectResult> {
  const parsed = input.safeParse({ org, name, slug, environments });
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
      const mine = ctx.orgs.find((o) => o.slug === orgSlug)?.projects.some((p) => p.slug === body.slug);
      if (mine) return { ok: true, slug: body.slug };
      return { ok: false, code: "slug_taken", suggestions: cleanSuggestions(err.problem?.suggestions) };
    }
  });
}
