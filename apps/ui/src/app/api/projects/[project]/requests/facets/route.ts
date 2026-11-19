// GET /api/projects/{slug}/requests/facets?field=&search=&limit=&offset=&<explore state>: the counts
// beside one of Explore's facets (#1052): requests per value of `field` under every other condition,
// most first, one page (`limit` values from `offset`), from `GET /requests/facets` as the signed-in
// user. Answers `{ok: true, values, has_more}` or `{ok: false, code}` (`session_expired` with 401).
import { type NextRequest, NextResponse } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { FACET_FIELDS, type FacetField, apiQuery, paramsRecord, readExploreUrl } from "@/lib/explore-query";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      const sp = req.nextUrl.searchParams;
      const field = sp.get("field") ?? "";
      if (!(FACET_FIELDS as readonly string[]).includes(field)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid field");
      const search = (sp.get("search") ?? "").trim().slice(0, 256);
      const q = readExploreUrl(paramsRecord(sp));
      // One page: `limit` values (at most 50, the API's; 20 while Path and Consumer search as you
      // type) from `offset`.
      const limit = Math.min(50, Math.max(1, Number.parseInt(sp.get("limit") ?? "", 10) || (search ? 20 : 50)));
      const offset = Math.min(1000, Math.max(0, Number.parseInt(sp.get("offset") ?? "", 10) || 0));
      const facets = await session.call((o) =>
        identity().requestFacets(project, { ...apiQuery(q, Date.now()), field: field as FacetField, limit, ...(offset ? { offset } : {}), ...(search ? { search } : {}) }, o),
      );
      const values = facets.values ?? [];
      // An API that does not say has_more: a full page may have more.
      return NextResponse.json({ ok: true, values, has_more: facets.has_more ?? values.length >= limit }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
