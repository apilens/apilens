// GET /api/projects/{slug}/requests?range=: the project's newest requests (#585), at most 200, from
// `GET /requests` as the signed-in user. Answers `{ok: true, requests}` or `{ok: false, code}`
// (`forbidden`, `not_found`, `rate_limited`, ...; `session_expired` with 401). The Explore request
// log polls it every 5 s while live.
import { type NextRequest, NextResponse } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { LOG_LIMIT, parseExploreQuery } from "@/lib/explore";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      const { range } = parseExploreQuery({ range: req.nextUrl.searchParams.get("range") ?? undefined });
      const page = await session.call((o) => identity().listRequests(project, { range, limit: LOG_LIMIT }, o));
      return NextResponse.json({ ok: true, requests: page.requests ?? [] }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
