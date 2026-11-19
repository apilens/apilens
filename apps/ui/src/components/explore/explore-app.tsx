"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { copyText } from "@/lib/clipboard";
import { rowKey } from "@/lib/explore";
import { type ColumnId, type ColumnPrefs, DEFAULT_PREFS, autoHidden, isPrefs, readPrefs } from "@/lib/explore-columns";
import { exportFileName, neighborId, rangeKeys, toCsv, toJson, windowAround } from "@/lib/explore-detail";
import {
  type Cond,
  type ExploreQuery,
  type ExploreRange,
  LIVE_POLL_MS,
  URL_DEBOUNCE_MS,
  exploreUrl,
  isCustom,
  rangeSentence,
  rangeText,
  routeSearch,
  shownClasses,
  withCodeLevels,
} from "@/lib/explore-query";
import { logPoll } from "@/lib/explore";
import { timelinePoll } from "@/lib/explore-timeline";
import type { NamedApp, RequestRow, RequestTimeline } from "@/lib/identity";
import { useTimeZone } from "@/lib/time-zone-context";
import { Icon } from "../icons";
import { ObIcon } from "../onboarding/ob";
import { AppNamesProvider } from "./app-names";
import { ColumnsMenu } from "./columns-menu";
import { download, ExportMenu } from "./export-dialog";
import { filterActions } from "./field-actions";
import { FieldMenu } from "./field-menu";
import { FacetPanel } from "./facets";
import { LogTable } from "./log-table";
import { PillBar } from "./pill-bar";
import { RequestDrawer, RequestPanel } from "./request-panel";
import { Shortcuts } from "./shortcuts";
import { FACETS_ACTIONS_ID, FACETS_SLOT_ID } from "./slots";
import { StatusChart } from "./status-chart";
import { useStored } from "./use-stored";

/** At and under this viewport width the shell's sidebar (and so the facets) sits in its drawer (shell.css). */
const DRAWER_AT = 860;
/** How many of its own URL writes the page recognises when the server answers with them. */
const SENT_KEPT = 8;
/** How long after F the C of "F then C" (clear filters) counts. */
const CHORD_MS = 1000;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(`(max-width: ${DRAWER_AT}px)`);
    const read = () => setNarrow(m.matches);
    read();
    m.addEventListener("change", read);
    return () => m.removeEventListener("change", read);
  }, []);
  return narrow;
}

/** An element of the shell's Explore sidebar (ExploreMenu) to portal into, once mounted. */
function useSlot(id: string): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setEl(document.getElementById(id)), [id]);
  return el;
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** The URL of `q` without the open request, to tell whether two states read the same rows. */
const dataUrl = (project: string, q: ExploreQuery) => exploreUrl(project, { ...q, id: undefined });

/**
 * Explore (#585, revamped after Supabase Unified Logs in #1052 and #1061): the facets in the
 * shell's secondary sidebar (portalled into ExploreMenu's slots; the Time Range is their first
 * facet), then a full-height page of one toolbar row (the sidebar toggle, the filter box, then
 * Refresh, Columns, Export and Live), the 60px chart
 * and the request table; a request opens in a drawer over the page from the right. The state
 * (range or window, conditions) lives here and in the URL: a change shows at once, and the URL
 * follows 250ms later (replace, so typing does not fill the history), which reads the rows again
 * on the server while the chart and table fade. Live (on by default) reads newer rows every 10 s;
 * picking a range pauses it. Keyboard: Shift+F the filter bar, F then C clears filters, ⌘J Live,
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
  now: number;
  notice?: ReactNode;
}) {
  const router = useRouter();
  const tz = useTimeZone();
  const narrow = useNarrow();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState<ExploreQuery>(query);
  const qRef = useRef(q);
  qRef.current = q;
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
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const facetSlot = useSlot(FACETS_SLOT_ID);
  const [shortcuts, setShortcuts] = useState(false);
  const toolsEnd = useRef<HTMLDivElement>(null);
  const [facetsHidden, setFacetsHidden] = useStored<boolean>("apilens.explore.facets.hidden", false, (v): v is boolean => typeof v === "boolean");
  const actionSlot = useSlot(FACETS_ACTIONS_ID);
  const [storedPrefs, setPrefs] = useStored<ColumnPrefs>("apilens.explore.columns", DEFAULT_PREFS, isPrefs);
  const prefs = readPrefs(storedPrefs);

  // The sidebar toggle (UnifiedLogs.tsx's DataTableSideBarLayout toggle) folds the shell's menu
  // holding the facets away on wide screens; on phones the facets are in the drawer it opens.
  useEffect(() => {
    const menu = facetSlot?.closest<HTMLElement>(".shell-menu");
    if (!menu) return;
    if (facetsHidden) menu.setAttribute("data-ex-hidden", "");
    else menu.removeAttribute("data-ex-hidden");
    return () => menu.removeAttribute("data-ex-hidden");
  }, [facetSlot, facetsHidden]);
  const toggleFacets = () => {
    if (narrow) document.querySelector<HTMLButtonElement>(".tb-menu")?.click();
    else setFacetsHidden(!facetsHidden);
  };

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
      qRef.current = next;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        // The latest state, the open request included.
        const now = qRef.current;
        sent.current = [...sent.current.slice(-(SENT_KEPT - 1)), dataUrl(project, now)];
        startTransition(() => router.replace(exploreUrl(project, now), { scroll: false }));
      }, URL_DEBOUNCE_MS);
    },
    [project, router],
  );

  /**
   * Opens (or closes, with undefined) a request in the panel: `?id=` changes in place (no new read
   * of the rows), so reload and shared links open the same request.
   */
  const openRequest = useCallback(
    (id: string | undefined) => {
      const next = { ...qRef.current, id };
      setQ(next);
      qRef.current = next;
      window.history.replaceState(window.history.state, "", exploreUrl(project, next));
    },
    [project],
  );

  // A ticked status code brings its level along while levels are ticked (the Level/Status rule,
  // explore-query.ts), whichever control added it.
  const setConds = useCallback((conds: Cond[]) => update({ ...q, conds: withCodeLevels(conds) }), [q, update]);
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

  // Multi-select (#1053): Shift-click and Shift+↑/↓ extend from the anchor, ⌘/Ctrl-click toggles.
  const keys = rows?.map(rowKey) ?? [];
  const onRow = (r: RequestRow, how: { shift: boolean; toggle: boolean }) => {
    const k = rowKey(r, keys.indexOf(r.id ?? ""));
    if (how.shift) {
      // Without an anchor (nothing clicked yet, or the selection was just cleared) the range starts here.
      if (!anchor.current) anchor.current = k;
      setSelected(new Set(rangeKeys(keys, anchor.current, k)));
      return;
    }
    if (how.toggle) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      });
      anchor.current = k;
      return;
    }
    anchor.current = k;
    setSelected(new Set());
    if (r.id) openRequest(r.id);
  };
  const onExtend = (from: RequestRow, to: RequestRow) => {
    // A fresh selection starts at the focused row, not at an anchor left from an earlier one.
    const a = selected.size && anchor.current ? anchor.current : rowKey(from, 0);
    anchor.current = a;
    setSelected(new Set(rangeKeys(keys, a, rowKey(to, 0))));
  };
  const onSelect = (r: RequestRow, on: boolean) => {
    const k = rowKey(r, 0);
    anchor.current = k;
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  };
  /** Empties the selection and forgets its anchor, so the next Shift-extend starts afresh. */
  const clearSelection = () => {
    anchor.current = null;
    setSelected(new Set());
  };
  const selectedRows = (rows ?? []).filter((r, i) => selected.has(rowKey(r, i)));

  const filterApi = {
    conds: q.conds,
    setConds,
    setWindow: (from: string, to: string) => setRange({ range: q.range, from, to }),
  };
  const cellMenu = (r: RequestRow, col: ColumnId) => {
    const value =
      col === "status" ? String(r.status_code) : col === "path" ? r.path : col === "app" ? (r.app_id ?? "") : col === "env" ? r.environment : col === "method" ? r.method : col === "consumer" ? r.consumer_id || r.consumer_name : "";
    const field = col === "status" ? "status" : col === "path" ? "path" : col === "app" ? "app" : col === "env" ? "env" : col === "method" ? "method" : col === "consumer" ? "consumer" : null;
    if (!field || !value) return null;
    return <FieldMenu label={col === "env" ? "Environment" : col[0].toUpperCase() + col.slice(1)} copy={value} actions={filterActions(filterApi, field, value)} />;
  };

  const openRow = q.id ? ((rows ?? []).find((r) => r.id === q.id) ?? null) : null;
  const move = (delta: number) => {
    if (!q.id || !rows) return;
    const next = neighborId(rows, q.id, delta);
    if (next) openRequest(next);
  };

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
        if (k === "j") {
          e.preventDefault();
          toggleLive();
        } else if (k === "u") {
          e.preventDefault();
          setPrefs(DEFAULT_PREFS);
        }
        return;
      }
      if (isTyping(e.target) || mod || e.altKey) return;
      if (e.key === "Escape") {
        if (document.querySelector(".org-pop, .ext-pop")) return;
        if (qRef.current.id) openRequest(undefined);
        else if (selected.size) clearSelection();
        return;
      }
      // With a request open, ↑/↓ and k/j walk the rows (the table moves its own focus the same way).
      if (qRef.current.id && !(e.target as HTMLElement).closest?.(".exl-grid") && ["ArrowDown", "ArrowUp", "j", "k"].includes(e.key) && !e.shiftKey) {
        e.preventDefault();
        move(e.key === "ArrowDown" || e.key === "j" ? 1 : -1);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcuts((o) => !o);
        return;
      }
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
  const facets = <FacetPanel project={project} query={q} onChange={setConds} onRange={setRange} refresh={refresh} />;
  const auto = autoHidden(rows ?? []);

  return (
    <AppNamesProvider apps={apps}>
      {facetSlot ? createPortal(facets, facetSlot) : null}
      {actionSlot && q.conds.length
        ? createPortal(
            <button type="button" className="exf-reset" onClick={() => setConds([])} title="Clear filters (F then C)">
              Reset
            </button>,
            actionSlot,
          )
        : null}
      <div className="exr">
        <div className="exr-main">
          {notice}
          {/* The toolbar row (search_bar_panel): the sidebar toggle in its own cell, the filter box,
              then tiny 26px buttons 8px apart (RefreshButton, DataTableViewOptions,
              DownloadLogsButton) and Live (LiveButton.tsx:68-77). */}
          <div className="exr-tools" role="toolbar" aria-label="Explore">
            <div className="exr-side">
              <button
                type="button"
                className="exr-sidebtn"
                aria-label={narrow ? "Show filters" : facetsHidden ? "Show filters" : "Hide filters"}
                title={narrow ? "Show filters" : facetsHidden ? "Show filters" : "Hide filters"}
                aria-expanded={narrow ? false : !facetsHidden}
                aria-controls={FACETS_SLOT_ID}
                onClick={toggleFacets}
              >
                <Icon name={!narrow && facetsHidden ? "panelOpen" : "panelClose"} />
                {narrow && q.conds.length ? <span className="exr-sidebtn__n">{q.conds.length}</span> : null}
              </button>
            </div>
            <div className="exr-filter">
              <PillBar query={q} conds={q.conds} onChange={setConds} onRange={setRange} inputRef={filterInput} apps={apps} environments={environments} />
            </div>
            <div className="exr-tools__end" ref={toolsEnd}>
              <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn ex-tbtn--icon" aria-label="Refresh logs" title="Refresh logs" disabled={pending} onClick={reload}>
                {pending ? (
                  <span className="ex-tbtn__spin">
                    <Icon name="loader" />
                  </span>
                ) : (
                  <Icon name="refresh" />
                )}
              </button>
              <ColumnsMenu prefs={prefs} auto={auto} onPrefs={setPrefs} />
              <ExportMenu project={project} query={q} rangeLabel={rangeText(q, tz)} />
              <Shortcuts open={shortcuts} onClose={() => setShortcuts(false)} anchor={toolsEnd} />
              <button
                type="button"
                className={`ah-btn ah-btn--sm ex-tbtn exr-live${liveOn ? " ah-btn--primary is-on" : " ah-btn--secondary"}`}
                aria-pressed={liveOn}
                title={`${liveOn ? "Pause live mode" : "Start live mode"} (⌘J)`}
                onClick={toggleLive}
              >
                <Icon name={liveOn ? "circlePause" : "circlePlay"} />
                Live
              </button>
            </div>
          </div>
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
                    <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn" onClick={() => setConds([])}>
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
                onOpen={onRow}
                openId={q.id ?? null}
                selected={selected}
                onSelect={onSelect}
                onExtend={onExtend}
                cellMenu={cellMenu}
              />
            )}
          </div>
        </div>
      </div>
      {selectedRows.length >= 2 ? (
        <RequestDrawer label="Selected requests" onClose={clearSelection}>
          <SelectionPanel
            rows={selectedRows}
            onClear={clearSelection}
            fileName={(ext) => exportFileName(project, isCustom(q) ? rangeText(q, tz) : q.range, Date.now(), ext)}
          />
        </RequestDrawer>
      ) : q.id ? (
        <RequestDrawer label="Request details" onClose={() => openRequest(undefined)}>
          <RequestPanel
            key={q.id}
            project={project}
            id={q.id}
            row={openRow}
            inList={openRow !== null || rows === null}
            link={exploreUrl(project, q)}
            api={filterApi}
            onClose={() => openRequest(undefined)}
            onMove={move}
            canPrev={Boolean(rows && openRow && rows[0]?.id !== q.id)}
            canNext={Boolean(rows && openRow && rows[rows.length - 1]?.id !== q.id)}
            onShowInList={(at) => {
              // Ten minutes around it, without the filters that may leave it out.
              const w = windowAround(at, 5);
              if (!w) return;
              setLive(false);
              update({ ...q, ...w, conds: [] });
            }}
          />
        </RequestDrawer>
      ) : null}
    </AppNamesProvider>
  );
}


/** Two or more rows selected: how many, Copy as JSON, Export selected and Clear selection. */
function SelectionPanel({ rows, onClear, fileName }: { rows: RequestRow[]; onClear: () => void; fileName: (ext: "csv" | "json") => string }) {
  const [said, setSaid] = useState<string | null>(null);
  // Written inside the click (lib/clipboard), as Safari asks.
  const copy = () =>
    copyText(toJson(rows)).then((ok) => setSaid(ok ? `Copied ${rows.length} requests as JSON.` : "Couldn’t copy. Your browser blocked the clipboard."));
  return (
    <section className="exd exd-sel" aria-label="Selected requests">
      <header className="exd-head">
        <h2 className="exd-title">{rows.length} requests selected</h2>
      </header>
      <p className="exd-said" role="status">
        {said}
      </p>
      <div className="exd-sel__actions">
        <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={copy}>
          Copy as JSON
        </button>
        <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={() => download(toCsv(rows), fileName("csv"), "text/csv")}>
          Export CSV
        </button>
        <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={() => download(toJson(rows), fileName("json"), "application/json")}>
          Export JSON
        </button>
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onClear}>
          Clear selection
        </button>
      </div>
      <p className="exd-keys exd-sel__hint">Shift-click or Shift ↑ ↓ to extend, ⌘ or Ctrl-click to add one, Esc to clear.</p>
    </section>
  );
}
