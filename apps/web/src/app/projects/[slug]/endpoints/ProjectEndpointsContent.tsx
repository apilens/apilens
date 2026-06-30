"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Fingerprint,
  Layers,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Timer,
  X,
} from "lucide-react";
import {
  formatBytes,
  formatMs,
  statusTone,
} from "./detail/sections";
import RequestLogDetailModal, { type RequestItem } from "./RequestLogDetailModal";
import {
  type RangeValue,
  DEFAULT_PRESET_ID,
  parseRange,
  resolveRange,
  TimeRangePicker,
} from "../_shared/timeRange";

interface ProjectEndpointsContentProps {
  projectSlug: string;
}

type AppOption = { id: string; name: string; slug: string };

interface RequestsResponse {
  items: RequestItem[];
  total_count: number;
  page: number;
  page_size: number;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
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

  const [apps, setApps] = useState<AppOption[]>([]);
  const [selectedAppSlugs, setSelectedAppSlugs] = useState<string[]>([]);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [selectedEnv, setSelectedEnv] = useState("");
  const [selectedConsumer, setSelectedConsumer] = useState("");
  const [rangeValue, setRangeValue] = useState<RangeValue>(() => parseRange({}));

  // Filters
  const [pathSearch, setPathSearch] = useState("");
  const [pathExact, setPathExact] = useState(false);
  const [methodsFilter, setMethodsFilter] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

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
    const pageParam = searchParams.get("page");
    const req = searchParams.get("req");

    setRangeValue(parseRange({
      range: range || undefined,
      since: sinceParam || undefined,
      until: untilParam || undefined,
    }));
    if (env) setSelectedEnv(env);
    if (appsParam) setSelectedAppSlugs(appsParam.split(",").filter(Boolean));
    else if (app) setSelectedAppSlugs([app]);
    if (methods) setMethodsFilter(new Set(methods.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean)));
    else if (method) setMethodsFilter(new Set([method.toUpperCase()]));
    if (path) {
      setPathSearch(path);
      setPathExact(true);
    } else if (q) {
      setPathSearch(q);
      setPathExact(false);
    }
    if (consumer) setSelectedConsumer(consumer);
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
    } else if (rangeValue.id !== DEFAULT_PRESET_ID) {
      p.set("range", rangeValue.id);
    }
    if (selectedEnv) p.set("env", selectedEnv);
    if (apps.length && selectedAppSlugs.length && selectedAppSlugs.length < apps.length) {
      p.set("apps", selectedAppSlugs.join(","));
    }
    if (methodsFilter.size) p.set("methods", [...methodsFilter].join(","));
    if (pathSearch.trim()) p.set(pathExact ? "path" : "q", pathSearch.trim());
    if (selectedConsumer) p.set("consumer", selectedConsumer);
    if (page > 1) p.set("page", String(page));
    if (openRow) p.set("req", openRow.timestamp);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [isInitialized, rangeValue, selectedEnv, apps.length, selectedAppSlugs, methodsFilter, pathSearch, pathExact, selectedConsumer, page, openRow]);

  // Apps + environments
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps`);
        if (res.ok) {
          const data = await res.json();
          const list: AppOption[] = (data.apps || []).map((a: AppOption) => ({ id: a.id, name: a.name, slug: a.slug }));
          setApps(list);
        }
      } catch { /* ignore */ }
    })();
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/environments`);
        if (res.ok) {
          const data = await res.json();
          setEnvironments(data.environments || []);
        }
      } catch { /* ignore */ }
    })();
  }, [projectSlug]);

  const resolved = useMemo(() => resolveRange(rangeValue), [rangeValue, refreshKey]);
  const { since, until } = resolved;

  const appScope = useCallback(
    (p: URLSearchParams) => {
      if (selectedAppSlugs.length && (apps.length === 0 || selectedAppSlugs.length < apps.length)) {
        p.set("app_slugs", selectedAppSlugs.join(","));
      }
    },
    [selectedAppSlugs, apps.length],
  );

  // Reset to page 1 when filters change.
  useEffect(() => {
    setPage(1);
  }, [since, until, selectedEnv, selectedConsumer, selectedAppSlugs, pathSearch, pathExact, methodsFilter]);

  // Request list.
  useEffect(() => {
    if (!isInitialized) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const p = new URLSearchParams();
      p.set("since", since);
      if (until) p.set("until", until);
      if (selectedEnv) p.set("environment", selectedEnv);
      appScope(p);
      if (methodsFilter.size) p.set("methods", [...methodsFilter].join(","));
      if (pathSearch.trim()) {
        const term = pathSearch.trim();
        p.set("path_filter", pathExact ? term : `*${term}*`);
      }
      if (selectedConsumer) p.set("consumer", selectedConsumer);
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
  }, [projectSlug, isInitialized, since, until, selectedEnv, selectedConsumer, selectedAppSlugs, methodsFilter, pathSearch, pathExact, page, appScope, refreshKey]);

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

  // Close the Filter popover on outside click.
  useEffect(() => {
    if (!filterOpen) return;
    const onClick = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [filterOpen]);

  const toggleMethod = (m: string) =>
    setMethodsFilter((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  const clearPath = () => { setPathSearch(""); setPathExact(false); };

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const activeFilters = methodsFilter.size + (pathSearch.trim() ? 1 : 0);

  return (
    <div className="ep-rl">
      {/* ── Toolbar ── */}
      <div className="ep-rl-toolbar">
        <h1 className="ep-rl-title">Request logs</h1>
        <div className="ep-rl-spacer" />

        <div className="ep-search ep-rl-search">
          <Search size={12} />
          <input
            type="text"
            value={pathSearch}
            onChange={(e) => { setPathSearch(e.target.value); setPathExact(false); }}
            placeholder="Search path…"
          />
          {pathSearch && (
            <button type="button" className="ep-search-clear" onClick={clearPath} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </div>

        <div className="ep-rl-filter" ref={filterRef}>
          <button
            type="button"
            className={`ep-rl-filter-btn${activeFilters ? " has-active" : ""}`}
            onClick={() => setFilterOpen((o) => !o)}
            aria-expanded={filterOpen}
          >
            <SlidersHorizontal size={13} />
            <span>Filter</span>
            {activeFilters ? <span className="ep-rl-filter-badge">{activeFilters}</span> : null}
          </button>
          {filterOpen && (
            <div className="ep-rl-filter-menu" role="dialog">
              <p className="ep-rl-filter-heading">Methods</p>
              <div className="ep-rl-method-grid">
                {METHODS.map((m) => {
                  const on = methodsFilter.has(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      className={`ep-rl-method-opt${on ? " on" : ""}`}
                      onClick={() => toggleMethod(m)}
                      style={on ? { color: methodColor(m), borderColor: methodColor(m) } : undefined}
                    >
                      {on && <Check size={11} />}
                      {m}
                    </button>
                  );
                })}
              </div>
              {(methodsFilter.size > 0 || pathSearch) && (
                <button
                  type="button"
                  className="ep-rl-filter-clear"
                  onClick={() => { setMethodsFilter(new Set()); clearPath(); }}
                >
                  Clear all filters
                </button>
              )}
            </div>
          )}
        </div>

        {apps.length > 1 && (
          <select
            className="ep-env-select"
            value={selectedAppSlugs.length === apps.length || selectedAppSlugs.length === 0 ? "" : selectedAppSlugs[0] || ""}
            onChange={(e) => setSelectedAppSlugs(e.target.value ? [e.target.value] : apps.map((a) => a.slug))}
          >
            <option value="">All apps</option>
            {apps.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
          </select>
        )}

        {environments.length > 0 && (
          <select className="ep-env-select" value={selectedEnv} onChange={(e) => setSelectedEnv(e.target.value)}>
            <option value="">All envs</option>
            {environments.map((env) => <option key={env} value={env}>{env}</option>)}
          </select>
        )}

        <TimeRangePicker value={rangeValue} resolved={resolved} onChange={setRangeValue} />

        <button type="button" className="tf-refresh" onClick={() => setRefreshKey((k) => k + 1)} title="Refresh" aria-label="Refresh">
          <RefreshCw size={14} className={loading ? "tf-spin" : ""} />
        </button>
      </div>

      {/* ── Active deep-link chips ── */}
      {((pathExact && pathSearch) || selectedConsumer) && (
        <div className="ep-rl-chips">
          {pathExact && pathSearch && (
            <span className="ep-rl-chip">
              Path = <span className="ep-rl-mono">{pathSearch}</span>
              <button type="button" onClick={clearPath} aria-label="Remove path filter"><X size={11} /></button>
            </span>
          )}
          {selectedConsumer && (
            <span className="ep-rl-chip">
              Consumer = <span className="ep-rl-mono">{selectedConsumer}</span>
              <button type="button" onClick={() => setSelectedConsumer("")} aria-label="Remove consumer filter"><X size={11} /></button>
            </span>
          )}
        </div>
      )}

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
                            onClick={(e) => { e.stopPropagation(); setSelectedConsumer(r.consumer_id || r.consumer_name); }}
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
          appSlugs={selectedAppSlugs.length && selectedAppSlugs.length < apps.length ? selectedAppSlugs : []}
          environment={selectedEnv || undefined}
          since={since}
          onClose={() => setOpenRow(null)}
          onFilterConsumer={(c) => { setSelectedConsumer(c); setOpenRow(null); }}
        />
      )}
    </div>
  );
}
