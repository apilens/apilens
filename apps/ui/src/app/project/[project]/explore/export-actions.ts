"use server";

// Server Actions of the Explore CSV export (#590): start an export of the request log with the
// page's range and filters, and cancel one. Each re-checks its input (a Server Action is a public
// POST endpoint), calls the API (#579) as the signed-in user and answers the export with its
// download link made absolute, or a sentence to show, never a raw error.
import { isProjectSlug } from "@/lib/api-keys";
import { env } from "@/lib/env";
import { exportBody, exportError, isExportId, withPublicLink } from "@/lib/explore-export";
import { type Cond, dedupe, parseCond } from "@/lib/explore-query";
import { type QueryRange, type RequestExport, identity, isApiError } from "@/lib/identity";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type ExportActionResult = { ok: true; export: RequestExport } | { ok: false; error: string; code?: string };

async function run(fn: (session: ServerSession) => Promise<RequestExport>): Promise<ExportActionResult> {
  return withActionSession(async (session) => {
    try {
      return { ok: true as const, export: withPublicLink(await fn(session), env().publicApiUrl) };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: exportError(err.code), code: err.code };
    }
  });
}

const RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];

/**
 * Starts an export of `project`'s request log. `input` is `{range, filters}`: the API's range and
 * Explore's `field:op:value` conditions (#1052); conditions the log would refuse are dropped, as
 * from a URL.
 */
export async function startRequestExport(project: unknown, input: unknown): Promise<ExportActionResult> {
  if (!isProjectSlug(project)) return { ok: false, error: exportError("forbidden"), code: "not_found" };
  const b = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const range = RANGES.includes(b.range as QueryRange) ? (b.range as QueryRange) : "1h";
  const raw = Array.isArray(b.filters) ? b.filters : [];
  const conds = dedupe(raw.map((s) => (typeof s === "string" ? parseCond(s) : null)).filter((c): c is Cond => c !== null));
  const body = exportBody(range, conds);
  return run((s) => s.call((o) => identity().createRequestExport(project, body, o)));
}

/** Cancels export `id`, queued or running. */
export async function cancelRequestExport(id: unknown): Promise<ExportActionResult> {
  if (!isExportId(id)) return { ok: false, error: exportError("not_found"), code: "not_found" };
  return run((s) => s.call((o) => identity().cancelRequestExport(id, o)));
}
