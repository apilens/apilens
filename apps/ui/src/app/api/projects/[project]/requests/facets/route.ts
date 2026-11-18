// GET /api/projects/{slug}/requests/facets?field=&search=&<explore state>: the counts beside one of
// Explore's facets (#1052): requests per value of `field` under every other condition, most first,
// from `GET /requests/facets` as the signed-in user. Answers `{ok: true, values}` or
// `{ok: false, code}` (`session_expired` with 401).
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
      // Path and Consumer search as you type: the 20 busiest matches.
      const facets = await session.call((o) =>
        identity().requestFacets(project, { ...apiQuery(q, Date.now()), field: field as FacetField, ...(search ? { search, limit: 20 } : {}) }, o),
      );
      return NextResponse.json({ ok: true, values: facets.values ?? [] }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
