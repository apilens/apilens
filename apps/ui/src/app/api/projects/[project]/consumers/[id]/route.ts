// GET /api/projects/{slug}/consumers/{id}: one consumer for Explore's request panel (#1053): when it
// was first and last seen, its group, and its 10 latest requests of the last 24 hours, from
// `GET /consumers/{id}` as the signed-in user. Answers `{ok: true, consumer}` or `{ok: false, code}`
// (`not_found` for a consumer the project never saw; `session_expired` with 401).
import { type NextRequest, NextResponse } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string; id: string }> }) {
  const { project, id } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      let consumer = id;
      try {
        consumer = decodeURIComponent(id);
      } catch {
        // Already decoded, with a literal %.
      }
      if (!consumer || consumer.length > 256) throw new InputError(404, "not_found", "consumer not found");
      const c = await session.call((o) => identity().getConsumer(project, consumer, { range: "24h", limit: 10 }, o));
      return NextResponse.json(
        {
          ok: true,
          consumer: {
            consumer_id: c.consumer_id,
            consumer_name: c.consumer_name,
            consumer_group: c.consumer_group,
            first_seen: c.first_seen,
            last_seen: c.last_seen,
            requests: c.summary?.requests ?? 0,
            recent: c.recent_requests ?? [],
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
