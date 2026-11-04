// GET /api/projects/{slug}/ingest-status: has the project received its first request yet (#334)?
// Answers `{ok: true, received, first_at, last_at, count_1h}` from `GET /projects/{slug}/ingest-status`
// (#287) as the signed-in user, or `{ok: false, code}` (`forbidden`, `not_found`, `rate_limited`,
// ...; `session_expired` with 401). The onboarding "Waiting for your first request" screen polls it.
import { type NextRequest, NextResponse } from "next/server";
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
      const s = await session.call((o) => identity().ingestStatus(project, o));
      return NextResponse.json(
        { ok: true, received: s.received === true, first_at: s.first_at ?? null, last_at: s.last_at ?? null, count_1h: s.count_1h ?? 0 },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
