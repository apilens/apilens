"use server";

// "Create organization" on the onboarding organization step (#330): `POST /orgs` as the
// signed-in user. Someone taking the address between the check and the click answers
// `slug_taken` with the API's suggestions, shown on the field. An address the user already owns
// counts as created, so pressing Create again after a failed progress save (or coming back to
// this screen) goes on instead of reporting the user's own organization as taken.
import { z } from "zod";
import { identity, isApiError } from "@/lib/identity";
import { type CreateOrgResult, ORG_SLUG, cleanSuggestions, createOrgError } from "@/lib/org-slug";
import { withActionSession } from "@/lib/server-session";

// The API's rules (CreateOrgInput): a Server Action is a public POST endpoint.
const input = z.strictObject({
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(ORG_SLUG),
});

export async function createOrganization(name: string, slug: string): Promise<CreateOrgResult> {
  const parsed = input.safeParse({ name, slug });
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
