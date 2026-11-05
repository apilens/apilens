// GET /api/projects/{slug}/incidents: how many of the project's incidents are open (#610), for the
// sidebar's Incidents badge. Answers `{ok: true, open}` from `GET /projects/{slug}/incidents` (#609)
// as the signed-in user, or `{ok: false, code}` (`forbidden`, `not_found`, `unavailable`, ...;
// `session_expired` with 401). The badge shows nothing unless the answer is ok.
import { type NextRequest, NextResponse } from "next/server";
import { openCount } from "@/lib/alerts";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      // Open incidents always count, whatever the range; the shortest keeps the read small.
      const res = await session.call((o) => identity().incidents(project, { range: "24h" }, o));
      return NextResponse.json({ ok: true, open: openCount(res?.incidents) }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
