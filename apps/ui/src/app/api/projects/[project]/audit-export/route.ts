// GET /api/projects/{slug}/audit-export?who=&group=&from=&to=: the project's activity log as CSV
// (#812), the Activity tab's current filter, from `GET /projects/{slug}/audit-events/export`
// (#784) as the signed-in user. The backend URL needs the user's Bearer token, so this route
// fetches it and streams the file through; the browser never sees the token. Answers the CSV, or
// `{ok: false, code}` (`forbidden` without `audit.read`, `validation` for a filter the export cannot
// hold in one file; `session_expired` with 401, or a redirect to sign-in for a navigation).
import { type NextRequest, NextResponse } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "@/lib/auth-routes";
import { exportFilters, parseActivityFilters } from "@/lib/audit";
import { ApiError, identity } from "@/lib/identity";
import { isSessionExpired, withSession } from "@/lib/server-session";

/** The headers of the backend's answer passed on to the browser. */
const PASSED = ["content-type", "content-disposition"];

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
      const scope = { project };
      const { actions } = await session.call((o) => identity().auditActions(scope, o));
      const filters = exportFilters(parseActivityFilters(req.nextUrl.searchParams), actions ?? []);
      if (!filters) throw new InputError(422, ROUTE_ERROR_CODES.validation, "this action group cannot be exported in one file");
      const url = identity().auditExportUrl(scope, filters);
      const res = await session.call(async (o) => {
        const headers = new Headers({ Accept: "text/csv", Authorization: `Bearer ${o.accessToken}`, "X-Request-Id": o.requestId ?? crypto.randomUUID() });
        if (o.forwardedFor) headers.set("X-Forwarded-For", o.forwardedFor);
        if (o.userAgent) headers.set("User-Agent", o.userAgent);
        const r = await fetch(url, { headers, cache: "no-store", redirect: "manual" });
        if (!r.ok) {
          const problem = (await r.json().catch(() => null)) as { code?: string } | null;
          throw new ApiError({ status: r.status, code: problem?.code ?? "export_failed" });
        }
        return r;
      });
      const out = new Headers({ "Cache-Control": "no-store" });
      for (const h of PASSED) {
        const v = res.headers.get(h);
        if (v) out.set(h, v);
      }
      return new NextResponse(res.body, { status: 200, headers: out });
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
