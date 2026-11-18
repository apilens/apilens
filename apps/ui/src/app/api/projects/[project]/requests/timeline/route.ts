// GET /api/projects/{slug}/requests/timeline?<explore state>: Explore's status chart (#587, #1052),
// the filtered request log counted per bucket by status class, from `GET /requests/timeline` as the
// signed-in user, with Supabase's bucket widths (minute under 12 h, hour under 2 d, day beyond).
// Answers `{ok: true, timeline}` or `{ok: false, code}` (`session_expired` with 401). Live reads it
// again with the log.
import { type NextRequest, NextResponse } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { apiQuery, bucketFor, paramsRecord, readExploreUrl } from "@/lib/explore-query";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      const q = readExploreUrl(paramsRecord(req.nextUrl.searchParams));
      const now = Date.now();
      const timeline = await session.call((o) => identity().requestTimeline(project, { ...apiQuery(q, now), bucket: bucketFor(q, now) }, o));
      return NextResponse.json({ ok: true, timeline }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
