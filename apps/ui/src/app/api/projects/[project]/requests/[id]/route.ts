// GET /api/projects/{slug}/requests/{id}: one request with the spans and logs of its trace (#588),
// from `GET /requests/{id}` (#577) as the signed-in user. Answers `{ok: true, detail}` or
// `{ok: false, code}` (`not_found` for an unknown or another project's id, `forbidden`, ...;
// `session_expired` with 401). The Explore request drawer reads it when a row opens.
import { type NextRequest, NextResponse } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

/** Request ids are base64url, at most 256 characters as the API takes them. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,256}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string; id: string }> }) {
  const { project, id } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      if (!REQUEST_ID.test(id)) throw new InputError(404, "not_found", "request not found");
      const detail = await session.call((o) => identity().getRequest(project, id, o));
      return NextResponse.json({ ok: true, detail }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
