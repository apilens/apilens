// GET /api/projects/slug-available?slug=: can a new project use this address (#331)? Answers
// `{ok: true, available, suggestions}` from `GET /projects/slug-available` as the signed-in user
// (project slugs are globally unique), or `{ok: false, code}` (`validation_failed` for a slug the
// API would refuse, `rate_limited`, ...). "Create your first project" calls it as the user types,
// debounced, aborting the previous call.
import { type NextRequest, NextResponse } from "next/server";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { ORG_SLUG, cleanSuggestions } from "@/lib/org-slug";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function GET(req: NextRequest) {
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      const slug = req.nextUrl.searchParams.get("slug") ?? "";
      if (!ORG_SLUG.test(slug)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid slug");
      const found = await session.call((o) => identity().projectSlugAvailable(slug, o));
      return NextResponse.json(
        { ok: true, available: found.available === true, suggestions: found.available ? [] : cleanSuggestions(found.suggestions) },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
