// GET /api/exports/{id}: one of the signed-in user's request log exports (#590), from
// `GET /exports/{id}` (#579), its download link made absolute against the browser-facing API
// origin. Answers `{ok: true, export}` or `{ok: false, code}` (`not_found` for an unknown or
// another user's export; `session_expired` with 401). The Explore export toast polls it while a
// job runs; the export history reads it for each remembered export.
import { type NextRequest, NextResponse } from "next/server";
import { InputError, checkRequest, fromError } from "@/lib/auth-routes";
import { env } from "@/lib/env";
import { isExportId, withPublicLink } from "@/lib/explore-export";
import { identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isExportId(id)) throw new InputError(404, "not_found", "export not found");
      const x = await session.call((o) => identity().getRequestExport(id, o));
      return NextResponse.json({ ok: true, export: withPublicLink(x, env().publicApiUrl) }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
