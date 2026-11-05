// GET /api/projects/{slug}/requests/timeline?range=&from=&to=&<filters>: the Explore timeline (#587),
// the filtered request log counted per bucket by status class, from `GET /requests/timeline` as the
// signed-in user. Answers `{ok: true, timeline}` or `{ok: false, code}` (`session_expired` with 401).
// The timeline polls it with the log while live.
import { type NextRequest, NextResponse } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { parseExploreQuery } from "@/lib/explore";
import { filterQuery } from "@/lib/explore-filters";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      const { range, from, to, filters } = parseExploreQuery(Object.fromEntries(req.nextUrl.searchParams));
      const timeline = await session.call((o) => identity().requestTimeline(project, { range, from, to, ...filterQuery(filters) }, o));
      return NextResponse.json({ ok: true, timeline }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
