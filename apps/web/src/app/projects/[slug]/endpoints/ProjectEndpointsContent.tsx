"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Fingerprint,
  Layers,
  RefreshCw,
  Timer,
} from "lucide-react";
import {
  formatBytes,
  formatMs,
  statusTone,
} from "./detail/sections";
import RequestLogDetailModal, { type RequestItem } from "./RequestLogDetailModal";
import {
  type RangeValue,
  parseRange,
  resolveRange,
  TimeRangePicker,
} from "../_shared/timeRange";
import FilterBar from "../_shared/filters/FilterBar";
import { parseFilter, upsertSingle } from "../_shared/filters/query";

interface ProjectEndpointsContentProps {
  projectSlug: string;
}

interface RequestsResponse {
  items: RequestItem[];
  total_count: number;
  page: number;
  page_size: number;
}

const PAGE_SIZE = 50;

function methodColor(m: string): string {
  const k = m.toUpperCase();
  if (k === "GET") return "#14b8a6";
  if (k === "POST") return "#5A9CF8";
  if (k === "PUT") return "#f59e0b";
  if (k === "PATCH") return "#a78bfa";
  if (k === "DELETE") return "#f87171";
  return "#94a3b8";
}
function reqKey(r: RequestItem): string {
  return `${r.timestamp}|${r.method}|${r.path}|${r.status_code}`;
}
function timeOfDay(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function dayLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const yest = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ── Component ───────────────────────────────────────────────────────── */

export default function ProjectEndpointsContent({ projectSlug }: ProjectEndpointsContentProps) {
  const searchParams = useSearchParams();

  const [rangeValue, setRangeValue] = useState<RangeValue>(() => parseRange({}));

  // Unified rich filter (canonical field:op:value;… string). App scope,
  // method, path, status, latency, consumer, env… all live in here.
  const [filter, setFilter] = useState("");

  // App slugs currently in the filter — used to scope the request-detail
  // modal's "related requests" lookup.
  const appSlugs = useMemo(
    () => parseFilter(filter).filter((p) => p.field === "app" && !p.negate).flatMap((p) => p.values),
    [filter],
  );

  // Data
  const [items, setItems] = useState<RequestItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const [openRow, setOpenRow] = useState<RequestItem | null>(null);
  const [initialReqTs, setInitialReqTs] = useState<string | null>(null);
  const appliedInitialRef = useRef(false);

  const [isInitialized, setIsInitialized] = useState(false);

  // Seed filters from the URL once. Supports both the Traffic-modal deep-link
  // (method + path + req) and a shared, fully-filtered URL (methods + q + page).
  useEffect(() => {
    if (isInitialized) return;
    const range = searchParams.get("range");
    const sinceParam = searchParams.get("since");
    const untilParam = searchParams.get("until");
    const env = searchParams.get("env");
    const appsParam = searchParams.get("apps");
    const app = searchParams.get("app");
    const method = searchParams.get("method");
    const methods = searchParams.get("methods");
    const path = searchParams.get("path");
    const q = searchParams.get("q");
    const consumer = searchParams.get("consumer");
    const filterParam = searchParams.get("filter");
    const pageParam = searchParams.get("page");
    const req = searchParams.get("req");

    setRangeValue(parseRange({
      range: range || undefined,
      since: sinceParam || undefined,
      until: untilParam || undefined,
    }));
    // Seed the rich filter from ?filter=, or migrate legacy deep-link params
    // (app/method/path/methods/q/env/consumer) so existing links keep working.
    if (filterParam) {
      setFilter(filterParam);
    } else {
      const seed: string[] = [];
      if (appsParam) {
        const as = appsParam.split(",").map((s) => s.trim()).filter(Boolean);
        if (as.length) seed.push(`app:is:${as.join(",")}`);
      } else if (app) {
        seed.push(`app:is:${app}`);
      }
      if (methods) {
        const ms = methods.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean);
        if (ms.length) seed.push(`method:is:${ms.join(",")}`);
      } else if (method) {
        seed.push(`method:is:${method.toUpperCase()}`);
      }
      if (path) seed.push(`path:is:${path}`);
      else if (q) seed.push(`path:contains:${q}`);
      if (env) seed.push(`env:is:${env}`);
      if (consumer) seed.push(`consumer:is:${consumer}`);
      if (seed.length) setFilter(seed.join(";"));
    }

    if (pageParam) {
      const pp = parseInt(pageParam, 10);
      if (pp > 1) setPage(pp);
    }
    if (req) setInitialReqTs(req);
    setIsInitialized(true);
  }, [searchParams, isInitialized]);

  // Mirror active filters into the URL (no navigation) so the view is shareable.
  useEffect(() => {
    if (!isInitialized) return;
    const p = new URLSearchParams();
    if (rangeValue.type === "custom") {
      p.set("since", rangeValue.since);
      p.set("until", rangeValue.until);
    } else {
      // Always surface the active range (including the 24h default) so the URL
      // fully describes the view and shared links keep their meaning.
      p.set("range", rangeValue.id);
    }
    if (filter) p.set("filter", filter);
    if (page > 1) p.set("page", String(page));
    if (openRow) p.set("req", openRow.timestamp);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [isInitialized, rangeValue, filter, page, openRow]);

  const resolved = useMemo(() => resolveRange(rangeValue), [rangeValue, refreshKey]);
  const { since, until } = resolved;

  // Reset to page 1 when filters change.
  useEffect(() => {
    setPage(1);
  }, [since, until, filter]);

  // Request list.
  useEffect(() => {
    if (!isInitialized) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const p = new URLSearchParams();
      p.set("since", since);
      if (until) p.set("until", until);
      if (filter) p.set("filter", filter);
      p.set("page", String(page));
      p.set("page_size", String(PAGE_SIZE));
      try {
        const res = await fetch(`/api/projects/${projectSlug}/data/requests?${p.toString()}`);
        const data: RequestsResponse = res.ok
          ? await res.json()
          : { items: [], total_count: 0, page: 1, page_size: PAGE_SIZE };
        if (cancelled) return;
        setItems(data.items || []);
        setTotalCount(data.total_count || 0);
      } catch {
        if (!cancelled) { setItems([]); setTotalCount(0); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectSlug, isInitialized, since, until, filter, page, refreshKey]);

  // Auto-open the deep-linked request once it shows up in the list.
  useEffect(() => {
    if (!initialReqTs || appliedInitialRef.current || loading) return;
    const target = new Date(initialReqTs).getTime();
    let best: RequestItem | null = null;
    let bestDiff = Infinity;
    for (const r of items) {
      const diff = Math.abs(new Date(r.timestamp).getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; best = r; }
    }
    if (best && bestDiff <= 2000) {
      appliedInitialRef.current = true;
      setOpenRow(best);
    }
  }, [items, initialReqTs, loading]);

  // Append a consumer predicate to the rich filter (used by row/modal clicks).
  const filterByConsumer = useCallback((consumerId: string) => {
    if (consumerId) setFilter((f) => upsertSingle(f, "consumer", "is", consumerId));
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="ep-rl">
      {/* ── Toolbar ── */}
      <div className="ep-rl-toolbar">
        <h1 className="ep-rl-title">Request logs</h1>
        <div className="ep-rl-spacer" />

        <TimeRangePicker value={rangeValue} resolved={resolved} onChange={setRangeValue} />

        <button type="button" className="tf-refresh" onClick={() => setRefreshKey((k) => k + 1)} title="Refresh" aria-label="Refresh">
          <RefreshCw size={14} className={loading ? "tf-spin" : ""} />
        </button>
      </div>

      {/* Full-width filter row (rich query bar). */}
      <div className="ep-rl-filterrow">
        <FilterBar projectSlug={projectSlug} value={filter} onChange={setFilter} />
      </div>

      {/* ── Request list ── */}
      <section className="ep-rl-card">
        {loading && items.length === 0 ? (
          <div className="ep-rl-message">Loading requests…</div>
        ) : items.length === 0 ? (
          <div className="ep-rl-message">No requests match these filters in this period.</div>
        ) : (
          <div className="ep-recent">
            <table className="ep-recent-table">
              <thead>
                <tr>
                  <th aria-hidden />
                  <th>Time</th>
                  <th>Status</th>
                  <th>Request</th>
                  <th aria-hidden />
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <tr
                    key={`${r.timestamp}-${i}`}
                    className={`ep-recent-row${openRow && reqKey(openRow) === reqKey(r) ? " is-open" : ""}`}
                    onClick={() => setOpenRow(r)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenRow(r); }
                    }}
                  >
                    <td className="ep-recent-clock"><Clock size={14} /></td>
                    <td className="ep-recent-time">
                      <span className="ep-recent-time-h">{timeOfDay(r.timestamp)}</span>
                      <span className="ep-recent-time-d">{dayLabel(r.timestamp)}</span>
                    </td>
                    <td><span className={`endpoint-status-pill ${statusTone(r.status_code)}`}>{r.status_code}</span></td>
                    <td className="ep-recent-req">
                      <div className="ep-recent-req-line">
                        <span className="ep-recent-method" style={{ color: methodColor(r.method) }}>{r.method}</span>
                        <span className="ep-recent-path">{r.path}</span>
                      </div>
                      <div className="ep-recent-meta">
                        {r.environment ? <span className="ep-recent-fact"><Layers size={12} />{r.environment}</span> : null}
                        {(r.consumer_name || r.consumer_id) ? (
                          <button
                            type="button"
                            className="ep-recent-fact ep-recent-consumer"
                            title={`Filter by consumer ${r.consumer_name || r.consumer_id}`}
                            onClick={(e) => { e.stopPropagation(); filterByConsumer(r.consumer_id || r.consumer_name); }}
                          >
                            <Fingerprint size={12} />{r.consumer_name || r.consumer_id}
                          </button>
                        ) : null}
                        {r.response_size > 0 ? <span className="ep-recent-fact">{formatBytes(r.response_size)}</span> : null}
                        <span className="ep-recent-fact"><Timer size={12} />{formatMs(r.response_time_ms)}</span>
                      </div>
                    </td>
                    <td className="ep-recent-go"><ChevronRight size={15} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalCount > 0 && (
          <div className="ep-rl-pager">
            <span className="ep-rl-pager-info">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount.toLocaleString()}
            </span>
            <div className="ep-rl-pager-btns">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft size={15} />
              </button>
              <span className="ep-rl-pager-page">Page {page} / {totalPages}</span>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
      </section>

      {openRow && (
        <RequestLogDetailModal
          projectSlug={projectSlug}
          row={openRow}
          appSlugs={appSlugs}
          since={since}
          onClose={() => setOpenRow(null)}
          onFilterConsumer={(c) => { filterByConsumer(c); setOpenRow(null); }}
        />
      )}
    </div>
  );
}
