// Loads one page of an audit log for Access › Activity (#812) and the organization's audit log
// (#813), so both pages read the log the same way. Server only: it calls the API as the signed-in
// user.
import { getSession } from "@/lib/auth/server";
import { type ActivityFilters, apiFilters, decodeBound, encodeBound, pageCut } from "./audit";
import { type AuditAction, type AuditEvent, type AuditScope, identity, isApiError } from "./identity";
import { type SearchParams, parseTrail, trailCursor } from "./pagination";
import { isSessionExpired, redirectToRefresh } from "./server-session";

/**
 * A session call for an audit page: the value, `"forbidden"` when the API answers 403 or 404, or
 * null for any other API failure. An expired session goes to refresh and comes back to `next`.
 */
export async function auditCaller(next: string) {
  const session = await getSession();
  return async <T,>(fn: Parameters<typeof session.call<T>>[0]): Promise<T | "forbidden" | null> => {
    try {
      return await session.call(fn);
    } catch (err) {
      if (isSessionExpired(err)) redirectToRefresh(next);
      if (isApiError(err)) return err.status === 403 || err.status === 404 ? "forbidden" : null;
      throw err;
    }
  };
}

export interface ActivityPage {
  /** The action catalogue (`auditActions`), in catalogue order. */
  actions: AuditAction[];
  events: AuditEvent[];
  /** The next page's cursor; null on the oldest page. */
  next: string | null;
  /** How many days events are kept (0: forever); null when unknown. */
  retentionDays: number | null;
}

/**
 * The action catalogue of `catalogue` and one page of `scope`'s events matching `filters`, from
 * the page cursor in `search`. `"forbidden"` when the caller may not read the log; null when the
 * API could not answer.
 */
export async function loadActivityPage(o: {
  scope: AuditScope;
  catalogue: AuditScope;
  filters: ActivityFilters;
  search: SearchParams;
  next: string;
  limit: number;
}): Promise<ActivityPage | "forbidden" | null> {
  const call = await auditCaller(o.next);
  const bound = decodeBound(trailCursor(parseTrail(o.search)));
  const listed = await call((a) => identity().auditActions(o.catalogue, a));
  if (listed === "forbidden" || listed === null) return listed;
  const actions = listed.actions ?? [];

  // One more than a page each: an answer with more may hold further events at its oldest time,
  // which pageCut leaves for the next page.
  const answers = await Promise.all(
    apiFilters(o.filters, actions).map((f) => call((a) => identity().listAuditEvents(o.scope, { ...f, ...(bound ? { to: bound } : {}), limit: o.limit + 1 }, a))),
  );
  if (answers.includes("forbidden")) return "forbidden";
  if (answers.includes(null)) return null;
  const pages = answers as Exclude<(typeof answers)[number], "forbidden" | null>[];
  const { events, next } = pageCut(
    pages.map((a) => ({ events: a.events ?? [], more: a.next_cursor !== "" })),
    o.limit,
  );
  // A group none of whose actions is offered asks nothing, and so learns no retention.
  return { actions, events, next: next ? encodeBound(next) : null, retentionDays: pages[0]?.retention_days ?? null };
}
