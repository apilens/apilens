"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { rowKey } from "@/lib/explore";
import { type ColumnPrefs, DEFAULT_PREFS, autoHidden, isPrefs, readPrefs } from "@/lib/explore-columns";
import {
  type Cond,
  type ExploreQuery,
  type ExploreRange,
  LIVE_POLL_MS,
  URL_DEBOUNCE_MS,
  exploreUrl,
  isCustom,
  rangeSentence,
  routeSearch,
  shownClasses,
} from "@/lib/explore-query";
import { logPoll } from "@/lib/explore";
import { timelinePoll } from "@/lib/explore-timeline";
import type { NamedApp, RequestRow, RequestTimeline, SavedView } from "@/lib/identity";
import { useTimeZone } from "@/lib/time-zone-context";
import { ObIcon } from "../onboarding/ob";
import { AppNamesProvider } from "./app-names";
import { ColumnsMenu } from "./columns-menu";
import { ExportMenu } from "./export";
import { FACETS_MIN, FacetPanel, FacetSidebar } from "./facets";
import { LogTable } from "./log-table";
import { PillBar } from "./pill-bar";
import { RangeMenu } from "./range-menu";
import { RequestDrawer } from "./request-drawer";
import { SaveView, SavedViews, ViewSwitcher } from "./saved-views";
import { StatusChart } from "./status-chart";
import { isBool, isNum, useStored } from "./use-stored";

/** Under this viewport width the facets open as a bottom sheet. */
const SHEET_BELOW = 760;
/** How many of its own URL writes the page recognises when the server answers with them. */
const SENT_KEPT = 8;
/** How long after F the C of "F then C" (clear filters) counts. */
const CHORD_MS = 1000;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(`(max-width: ${SHEET_BELOW - 1}px)`);
    const read = () => setNarrow(m.matches);
    read();
    m.addEventListener("change", read);
    return () => m.removeEventListener("change", read);
  }, []);
  return narrow;
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** The URL of `q` without the open request, to tell whether two states read the same rows. */
const dataUrl = (project: string, q: ExploreQuery) => exploreUrl(project, { ...q, id: undefined });

/**
 * Explore (#585, revamped after Supabase Unified Logs in #1052): a full-height page of a facet
 * sidebar, one toolbar row, a 60px status chart and the request table. The state (range or window,
 * conditions) lives here and in the URL: a change shows at once, and the URL follows 250ms later
 * (replace, so typing does not fill the history), which reads the rows again on the server while
 * the chart and table fade. Live (on by default) reads newer rows every 10 s; picking a range
 * pauses it. Keyboard: Shift+F the filter bar, F then C clears filters, ⌘B the sidebar, ⌘J Live,
 * ⌘U resets the columns.
 */
export function ExploreApp({
  project,
  environments,
  apps,
  query,
  rows: initialRows,
  cursor: initialCursor,
  timeline: initialTimeline,
  views,
  me,
  now: serverNow,
  notice,
}: {
  project: string;
  environments: readonly string[];
  apps: NamedApp[] | null;
  query: ExploreQuery;
  rows: RequestRow[] | null;
  cursor: string;
  timeline: RequestTimeline | null;
  views: SavedView[] | null;
  me: string;
  now: number;
  notice?: ReactNode;
}) {
  const router = useRouter();
  const tz = useTimeZone();
  const narrow = useNarrow();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState<ExploreQuery>(query);
  const sent = useRef<string[]>([dataUrl(project, query)]);
  const timer = useRef(0);
  const filterInput = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<RequestRow[] | null>(initialRows);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [cursor, setCursor] = useState(initialCursor);
  const [timeline, setTimeline] = useState<RequestTimeline | null>(initialTimeline);
  const [now, setNow] = useState(serverNow);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [live, setLive] = useState(true);
  const [dimBefore, setDimBefore] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [opened, setOpened] = useState<(RequestRow & { id: string }) | null>(null);
  const [sheet, setSheet] = useState(false);
  const [sideOpen, setSideOpen] = useStored("apilens.explore.facets.shown", true, isBool);
  const [sideWidth, setSideWidth] = useStored("apilens.explore.facets.width", FACETS_MIN, isNum);
  const [storedPrefs, setPrefs] = useStored<ColumnPrefs>("apilens.explore.columns", DEFAULT_PREFS, isPrefs);
  const prefs = readPrefs(storedPrefs);

  // The server answered: new rows for the URL. A URL this page did not write (back, forward, a
  // link) also brings its own state.
  useEffect(() => {
    const url = dataUrl(project, query);
    const echo = sent.current.indexOf(url);
    if (echo >= 0) sent.current = sent.current.slice(echo);
    else {
      sent.current = [url];
      setQ(query);
    }
  }, [query, project]);

  useEffect(() => {
    setRows(initialRows);
    setCursor(initialCursor);
    setTimeline(initialTimeline);
    setNow(serverNow);
    setPollFailed(false);
  }, [initialRows, initialCursor, initialTimeline, serverNow]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /** Shows `next` at once and writes it to the URL once changes pause. */
  const update = useCallback(
    (next: ExploreQuery) => {
      setQ(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const url = dataUrl(project, next);
        sent.current = [...sent.current.slice(-(SENT_KEPT - 1)), url];
        startTransition(() => router.replace(exploreUrl(project, next), { scroll: false }));
      }, URL_DEBOUNCE_MS);
    },
    [project, router],
  );

  const setConds = useCallback((conds: Cond[]) => update({ ...q, conds }), [q, update]);
  const setRange = useCallback(
    (r: { range: ExploreRange; from?: string; to?: string }) => {
      // Picking a range or a window pauses Live (Supabase exits live on a date pick).
      setLive(false);
      update({ ...q, range: r.range, from: r.from, to: r.to });
    },
    [q, update],
  );

  // The shown rows are another query's until the server answers: fade them, as on a refetch.
  const stale = pending || dataUrl(project, q) !== dataUrl(project, query);
  const canLive = !q.to;
  const liveOn = live && canLive && !stale;

  const goLive = () => {
    setDimBefore(rows?.length ? Date.parse(rows[0].timestamp) : Date.now());
    setLive(true);
    if (isCustom(q)) update({ ...q, from: undefined, to: undefined });
  };
  const toggleLive = () => (liveOn ? setLive(false) : goLive());

  // Live: the newest page and the chart again every 10 s (not while the tab is hidden); rows not
  // seen yet go on top.
  const logPath = `/api/projects/${encodeURIComponent(project)}/requests${routeSearch(query)}`;
  const chartPath = `/api/projects/${encodeURIComponent(project)}/requests/timeline${routeSearch(query)}`;
  useEffect(() => {
    if (!liveOn) return;
    let inflight: AbortController | null = null;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inflight) return;
      inflight = new AbortController();
      const opts = { signal: inflight.signal, cache: "no-store" as const, headers: { accept: "application/json" } };
      try {
        const [logRes, chartRes] = await Promise.all([fetch(logPath, opts), fetch(chartPath, opts)]);
        const log = logPoll(logRes.status, await logRes.json().catch(() => null));
        const chart = timelinePoll(chartRes.status, await chartRes.json().catch(() => null));
        if (log.kind === "expired") return window.location.assign(log.next);
        if (chart.kind === "timeline") setTimeline(chart.timeline);
        if (log.kind === "error") return setPollFailed(true);
        setPollFailed(false);
        setNow(Date.now());
        const cur = rowsRef.current;
        if (cur === null) {
          setRows(log.rows);
          setCursor(log.older);
          return;
        }
        const seen = new Set(cur.map(rowKey));
        const newest = cur.length ? Date.parse(cur[0].timestamp) : 0;
        const fresh = log.rows.filter((r, i) => !seen.has(rowKey(r, i)) && Date.parse(r.timestamp) >= newest);
        if (fresh.length) setRows([...fresh, ...cur]);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setPollFailed(true);
      } finally {
        inflight = null;
      }
    };
    const id = window.setInterval(tick, LIVE_POLL_MS);
    return () => {
      window.clearInterval(id);
      inflight?.abort();
    };
  }, [liveOn, logPath, chartPath]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/requests${routeSearch(query, { cursor })}`, { cache: "no-store", headers: { accept: "application/json" } });
      const page = logPoll(res.status, await res.json().catch(() => null));
      if (page.kind === "expired") return window.location.assign(page.next);
      if (page.kind === "error") return setPollFailed(true);
      setRows((cur) => {
        const seen = new Set((cur ?? []).map(rowKey));
        return [...(cur ?? []), ...page.rows.filter((r, i) => !seen.has(rowKey(r, i)))];
      });
      setCursor(page.older);
    } catch {
      setPollFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, project, query]);

  const reload = () => {
    setRefresh((n) => n + 1);
    startTransition(() => router.refresh());
  };

  // Keyboard shortcuts of the page; typing in a field keeps its keys.
  const chord = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "b") {
          e.preventDefault();
          if (narrow) setSheet((s) => !s);
          else setSideOpen((o) => !o);
        } else if (k === "j") {
          e.preventDefault();
          toggleLive();
        } else if (k === "u") {
          e.preventDefault();
          setPrefs(DEFAULT_PREFS);
        }
        return;
      }
      if (isTyping(e.target) || mod || e.altKey) return;
      if (e.key === "F" && e.shiftKey) {
        e.preventDefault();
        filterInput.current?.focus();
        return;
      }
      if (e.key === "f" && !e.shiftKey) {
        chord.current = Date.now();
        return;
      }
      if (e.key === "c" && !e.shiftKey && Date.now() - chord.current < CHORD_MS) {
        chord.current = 0;
        e.preventDefault();
        setConds([]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const total = timeline ? (timeline.buckets ?? []).reduce((n, b) => n + b.requests, 0) : null;
  const facets = <FacetPanel project={project} query={q} onChange={setConds} refresh={refresh} />;
  const auto = autoHidden(rows ?? []);

  return (
    <AppNamesProvider apps={apps}>
      <SavedViews project={project} me={me} conds={q.conds} apply={setConds} initial={views}>
        <div className="exr">
          {!narrow && sideOpen ? (
            <FacetSidebar width={sideWidth} onWidth={setSideWidth}>
              {facets}
            </FacetSidebar>
          ) : null}
          <div className="exr-main">
            <div className="exr-title">
              <h1>Explore</h1>
            </div>
            {notice}
            <div className="exr-tools" role="toolbar" aria-label="Explore">
              {narrow ? (
                <button type="button" className="ex-tbtn" aria-haspopup="dialog" aria-expanded={sheet} onClick={() => setSheet(true)}>
                  Filters{q.conds.length ? ` (${q.conds.length})` : ""}
                </button>
              ) : (
                <button
                  type="button"
                  className="ex-tbtn ex-tbtn--icon"
                  aria-pressed={sideOpen}
                  aria-label={sideOpen ? "Hide filters" : "Show filters"}
                  title={`${sideOpen ? "Hide" : "Show"} filters (⌘B)`}
                  onClick={() => setSideOpen((o) => !o)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" className="ex-tbtn__icon">
                    <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" />
                    <path d="M6.25 2.75v10.5" />
                  </svg>
                </button>
              )}
              <RangeMenu query={q} onRange={setRange} />
              <PillBar conds={q.conds} onChange={setConds} inputRef={filterInput} apps={apps} environments={environments} />
              <div className="exr-tools__end">
                <button type="button" className="ex-tbtn ex-tbtn--icon" aria-label="Refresh" title="Refresh" onClick={reload}>
                  <svg viewBox="0 0 16 16" aria-hidden="true" className={`ex-tbtn__icon${pending ? " is-spinning" : ""}`}>
                    <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.75v3h-3" />
                  </svg>
                </button>
                <ViewSwitcher />
                <SaveView />
                <ColumnsMenu prefs={prefs} auto={auto} onPrefs={setPrefs} />
                <ExportMenu project={project} query={q} className="ex-tbtn" />
                <button
                  type="button"
                  className={`ex-tbtn exr-live${liveOn ? " is-on" : ""}`}
                  aria-pressed={liveOn}
                  title={`${liveOn ? "Pause" : "Resume"} live updates (⌘J)`}
                  onClick={toggleLive}
                >
                  <span className="exr-live__dot" aria-hidden="true" />
                  Live
                </button>
              </div>
            </div>
            {!liveOn && canLive && !stale ? (
              <p className="exr-paused" role="status">
                Live paused.{" "}
                <button type="button" className="exf-link" onClick={goLive}>
                  Back to live
                </button>
              </p>
            ) : !canLive ? (
              <p className="exr-paused" role="status">
                Showing a past window.{" "}
                <button type="button" className="exf-link" onClick={goLive}>
                  Back to live
                </button>
              </p>
            ) : null}
            {pollFailed && rows !== null && rows.length > 0 ? (
              <p className="exr-banner" role="status">
                Couldn’t refresh. These are the last rows we read.{" "}
                <button type="button" className="exf-link" onClick={reload}>
                  Retry
                </button>
              </p>
            ) : null}
            <div className={`exr-data${stale ? " is-stale" : ""}`} aria-busy={stale || undefined}>
              <StatusChart timeline={timeline} shown={shownClasses(q.conds)} onRange={(from, to) => setRange({ range: q.range, from, to })} />
              {rows === null && !stale ? (
                <div className="ex-notice ex-notice--error" role="alert">
                  <ObIcon name="info" />
                  <p>
                    We couldn’t load requests just now.{" "}
                    <button type="button" className="exf-link" onClick={reload}>
                      Retry
                    </button>
                  </p>
                </div>
              ) : rows !== null && rows.length === 0 && !stale ? (
                <div className="exr-empty" role="status">
                  {query.conds.length ? (
                    <>
                      <p className="exr-empty__title">No requests match these filters</p>
                      <p>In {rangeSentence(query, tz)}.</p>
                      <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={() => setConds([])}>
                        Clear filters
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="exr-empty__title">No requests in {rangeSentence(query, tz)}</p>
                      <p>Once your app reports requests through the SDK, they show up here within seconds.</p>
                    </>
                  )}
                </div>
              ) : (
                <LogTable
                  rows={rows === null || (stale && rows.length === 0) ? null : rows}
                  prefs={prefs}
                  now={now}
                  dimBefore={liveOn ? dimBefore : null}
                  total={total}
                  hasMore={Boolean(cursor)}
                  loadingMore={loadingMore}
                  onLoadMore={loadMore}
                  onOpen={(r) => r.id && setOpened({ ...r, id: r.id })}
                />
              )}
            </div>
          </div>
        </div>
        {narrow && sheet ? <FacetSheet onClose={() => setSheet(false)}>{facets}</FacetSheet> : null}
        {opened ? <RequestDrawer key={opened.id} project={project} row={opened} onClose={() => setOpened(null)} /> : null}
      </SavedViews>
    </AppNamesProvider>
  );
}

/** Phones: the facets in a bottom sheet over the page. */
function FacetSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="exs">
      <div className="exs-scrim" onClick={onClose} aria-hidden="true" />
      <div className="exs-sheet" role="dialog" aria-modal="true" aria-label="Filters" ref={ref}>
        <button type="button" className="exs-close ah-btn ah-btn--secondary ah-btn--sm" onClick={onClose}>
          Done
        </button>
        {children}
      </div>
    </div>
  );
}
