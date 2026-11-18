// GET /api/projects/{slug}/requests?<explore state>&cursor=: one page of the project's request log
// (#585), newest first, from `GET /requests` as the signed-in user, narrowed by Explore's
// conditions (`?filter=field:op:value`, #1052) and window. Answers `{ok: true, requests,
// next_cursor}` (next_cursor "" on the last page) or `{ok: false, code}` (`session_expired` with
// 401). The table calls it for the next page as it scrolls, and Live for the newest rows.
import { type NextRequest, NextResponse } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { PAGE_SIZE, apiQuery, paramsRecord, readExploreUrl } from "@/lib/explore-query";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

const CURSOR_RE = /^[A-Za-z0-9_-]{1,256}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      const sp = req.nextUrl.searchParams;
      const cursor = sp.get("cursor") ?? "";
      if (cursor && !CURSOR_RE.test(cursor)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid cursor");
      const q = readExploreUrl(paramsRecord(sp));
      const page = await session.call((o) => identity().listRequests(project, { ...apiQuery(q, Date.now()), limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, o));
      return NextResponse.json({ ok: true, requests: page.requests ?? [], next_cursor: page.next_cursor ?? "" }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
