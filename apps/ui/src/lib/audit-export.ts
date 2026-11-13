// The CSV export of an audit log through a server route (#812, #813): the backend URL needs the
// user's Bearer token, so the route fetches it and streams the file through; the browser never
// sees the token. Answers the CSV, or `{ok: false, code}` (`forbidden` without the right to read
// the log, `validation` for a filter the export cannot hold in one file; `session_expired` with
// 401, or a redirect to sign-in for a navigation).
import { type NextRequest, NextResponse } from "next/server";
import { InputError, ROUTE_ERROR_CODES, checkRequest, fromError } from "./auth-routes";
import { exportFilters, parseActivityFilters } from "./audit";
import { ApiError, type AuditScope, identity } from "./identity";
import { isSessionExpired, withSession } from "./server-session";

/** The headers of the backend's answer passed on to the browser. */
const PASSED = ["content-type", "content-disposition"];

/**
 * Streams the export of `scope` with the filters in the request's query (`who`, `group`, `from`,
 * `to`); `target` checks the route's own parameters (throwing an InputError) and names the log and
 * the scope whose action catalogue expands a group.
 */
export function auditExport(req: NextRequest, target: () => { scope: AuditScope; catalogue: AuditScope }): Promise<NextResponse> {
  return withSession(req, async (session) => {
    try {
      checkRequest(req);
      const { scope, catalogue } = target();
      const { actions } = await session.call((o) => identity().auditActions(catalogue, o));
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
