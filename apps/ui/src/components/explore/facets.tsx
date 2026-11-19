"use client";

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type Cond,
  type ExploreQuery,
  type FacetField,
  LEVELS,
  LEVEL_CLASS,
  type Level,
  PANEL_FIELDS,
  type PanelField,
  clearField,
  compactCount,
  levelOf,
  levelState,
  onlyValue,
  routeSearch,
  statusHit,
  statusInLevels,
  statusTermHit,
  ticked,
  toggleLevel,
  toggleStatus,
  toggleValue,
} from "@/lib/explore-query";
import { reasonPhrase, statusText } from "@/lib/http-status";
import { Icon } from "../icons";
import { useAppNames } from "./app-names";
import { type RangePick, TimeRangeFacet } from "./time-range";
import { isOpenMap, useStored } from "./use-stored";

/** A list taller than this (px) scrolls, as Supabase's. */
const LIST_MAX = 215;
/** Lists with more values than this get a search box. */
const SEARCH_FROM = 4;
/** How long typed search waits before it asks the API (useUnifiedLogsPathnameOptions.ts:24). */
const SEARCH_DEBOUNCE_MS = 700;

const LABELS: Record<PanelField, string> = {
  level: "Level",
  status: "Status",
  app: "App",
  env: "Environment",
  method: "Method",
  path: "Path",
  consumer: "Consumer",
  consumer_group: "Consumer group",
};

/** Open until toggled: Time Range, Level, App and Environment (Supabase opens Time Range and Level, closes Status). */
const DEFAULT_OPEN: Record<string, boolean> = { time: true, level: true, app: true, env: true };

/** Facets that ask the API as you type (their values are too many to list). */
const ASYNC: ReadonlySet<PanelField> = new Set(["path", "consumer"]);

type Values = { value: string; label: string; count: number }[];
/** `search` is the search the values answer, so typed-ahead text can hide stale values. */
type Read = { state: "loading" } | { state: "error" } | { state: "ok"; values: Values; search: string };

/**
 * The counts of one facet: requests per value under every other condition (the field's own are
 * left out, so ticking one value keeps the others), read when the facet is open and again when
 * the other conditions, the window or `refresh` change.
 */
function useFacetValues(project: string, q: ExploreQuery, panel: PanelField, search: string, enabled: boolean, refresh: number): [Read, () => void, boolean] {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [fetching, setFetching] = useState(false);
  const [retry, setRetry] = useState(0);
  // Level and Status both read the status counts with neither's conditions (the API leaves out
  // status ones anyway); each applies the other's in the browser (levelValues, statusValues).
  const field: FacetField = panel === "level" ? "status" : panel;
  const others = field === "status" ? clearField(clearField(q.conds, "status"), "level") : clearField(q.conds, field);
  const path = `/api/projects/${encodeURIComponent(project)}/requests/facets${routeSearch({ ...q, conds: others }, { field, ...(search ? { search } : {}) })}`;
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setRead((r) => (r.state === "ok" ? r : { state: "loading" }));
    const t = window.setTimeout(
      async () => {
        setFetching(true);
        try {
          const res = await fetch(path, { signal: ctl.signal, cache: "no-store", headers: { accept: "application/json" } });
          const body = (await res.json().catch(() => null)) as { ok?: boolean; values?: Values; code?: string; next?: string } | null;
          if (res.status === 401 && body?.code === "session_expired") {
            window.location.assign(body.next ?? "/sign-in");
            return;
          }
          setRead(body?.ok ? { state: "ok", values: body.values ?? [], search } : { state: "error" });
          setFetching(false);
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            setRead({ state: "error" });
            setFetching(false);
          }
        }
      },
      search ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [path, enabled, refresh, retry, search]);
  return [read, () => setRetry((n) => n + 1), fetching];
}

/**
 * Explore's facet sidebar (#1052, after Supabase's DataTableFilterCheckbox): first the Time Range
 * (the only place the range is set, time-range.tsx), then Level (success,
 * warning, error), Status (the codes), App, Environment, Method, Path, Consumer and Consumer group, each a list of values with a checkbox
 * and the server's count (compact mono, 1.2k). Hovering a value swaps its count for "Only", which
 * keeps just that value. Ticking adds an `=` condition, so the facets and the filter bar's pills
 * are one filter set. Path and Consumer search the API as you type. Each facet has its own Reset;
 * the sidebar header's Reset (Explore's own, #1061) clears every filter.
 */
export function FacetPanel({
  project,
  query: q,
  onChange,
  onRange,
  refresh,
}: {
  project: string;
  query: ExploreQuery;
  onChange: (conds: Cond[]) => void;
  onRange: (r: RangePick) => void;
  refresh: number;
}) {
  const [open, setOpen] = useStored<Record<string, boolean>>("apilens.explore.facets.open", DEFAULT_OPEN, isOpenMap);
  // A facet the stored map doesn't name yet (Level, added after the map was stored) opens as its default.
  const isOpen = (f: PanelField) => open[f] ?? (DEFAULT_OPEN[f] || q.conds.some((c) => c.field === f));
  return (
    <div className="exf" role="region" aria-label="Filters">
      <div className="exf-scroll">
        <TimeRangeFacet query={q} onRange={onRange} open={open.time ?? true} onToggle={() => setOpen((m) => ({ ...m, time: !(m.time ?? true) }))} />
        {PANEL_FIELDS.map((f) => (
          <Facet
            key={f}
            project={project}
            field={f}
            query={q}
            onChange={onChange}
            open={isOpen(f)}
            onToggle={() => setOpen((m) => ({ ...m, [f]: !isOpen(f) }))}
            refresh={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function Facet({
  project,
  field,
  query: q,
  onChange,
  open,
  onToggle,
  refresh,
}: {
  project: string;
  field: PanelField;
  query: ExploreQuery;
  onChange: (conds: Cond[]) => void;
  open: boolean;
  onToggle: () => void;
  refresh: number;
}) {
  const id = useId();
  const appName = useAppNames();
  const [search, setSearch] = useState("");
  const async = ASYNC.has(field);
  const typed = async ? search.trim() : "";
  const [read, retry, fetching] = useFacetValues(project, q, field, typed, open, refresh);
  const selected = ticked(q.conds, field);
  const active = q.conds.filter((c) => c.field === field).length;
  // Supabase hides an async facet's values until they answer what's typed (useUnifiedLogsPathnameOptions.ts:61).
  const settled = read.state === "ok" && (!async || read.search === typed);

  const label = (v: { value: string; label: string }) => {
    if (field === "app") return appName(v.value) ?? `Unknown app ${v.value.slice(0, 8)}`;
    if (field === "consumer") return v.label.trim() || v.value;
    if (field === "status") return /^\d{3}$/.test(v.value) ? statusText(Number(v.value)) : v.value;
    if (field === "level") return `${v.value[0].toUpperCase()}${v.value.slice(1)} (${LEVEL_CLASS[v.value as Level]})`;
    return v.value;
  };

  // Ticked values come first (useUnifiedLogsPathnameOptions.ts:62-73); one the counts no longer
  // list stays, at 0, so it can be unticked.
  // Level and Status are one hierarchy (explore-query.ts): Level counts whole levels (only status
  // exclusions apply), Status lists only the codes inside the ticked levels.
  const statusConds = q.conds.filter((c) => c.field === "status" && c.op === "neq");
  const levelConds = q.conds.filter((c) => c.field === "level");
  const values: Values = useMemo(() => {
    let list = read.state === "ok" && settled ? read.values : [];
    if (field === "level") return levelValues(list, statusConds);
    if (field === "status") list = list.filter((v) => !/^\d{3}$/.test(v.value) || statusInLevels(Number(v.value), levelConds));
    // A ticked term the counts don't list (a class or range from an older link) counts its codes.
    const sum = (s: string) => list.reduce((n, v) => n + (field === "status" && /^\d{3}$/.test(v.value) && statusTermHit(Number(v.value), s) ? v.count : 0), 0);
    const picked = selected.map((s) => list.find((v) => v.value === s) ?? { value: s, label: "", count: sum(s) });
    return [...picked, ...list.filter((v) => !selected.includes(v.value))];
  }, [read, settled, selected.join("\n"), field, JSON.stringify(statusConds), JSON.stringify(levelConds)]);

  const needle = search.trim().toLowerCase();
  const local = !async && needle ? values.filter((v) => `${v.value} ${label(v)}`.toLowerCase().includes(needle)) : values;
  const searchable = async || (field !== "level" && values.length > SEARCH_FROM);
  const waiting = read.state === "loading" || (async && read.state === "ok" && !settled);

  const set = (value: string, on: boolean) =>
    onChange(field === "level" ? toggleLevel(q.conds, value as Level) : field === "status" ? toggleStatus(q.conds, value, on) : toggleValue(q.conds, field, value, on));
  // "Only" of a level or a code replaces both fields: just that level, or just that code.
  const only = (value: string) => onChange(field === "level" || field === "status" ? onlyValue(clearField(q.conds, field === "level" ? "status" : "level"), field, value) : onlyValue(q.conds, field, value));
  const isOn = (value: string) => (field === "level" ? levelState(q.conds, value as Level) !== "off" : selected.includes(value));

  return (
    <section className={`exf-facet${open ? " is-open" : ""}`} aria-labelledby={`${id}-h`}>
      <div className="exf-facet__head">
        <h3 className="exf-facet__title" id={`${id}-h`}>
          <button type="button" aria-expanded={open} aria-controls={`${id}-b`} onClick={onToggle}>
            <span className="exf-facet__name">{LABELS[field]}</span>
            <Icon name="chevronDown" />
          </button>
        </h3>
        {active ? (
          <button type="button" className="exf-clear" aria-label={`Reset ${LABELS[field]} (${active} selected)`} onClick={() => onChange(clearField(q.conds, field))}>
            <Icon name="x" />
            <span>{active}</span>
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="exf-facet__body" id={`${id}-b`}>
          {searchable ? (
            <div className="exf-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label={`Search ${LABELS[field]}`}
                placeholder="Search"
                value={search}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  // onSearchInputEscape (lib/keyboard): Escape clears a typed search first.
                  if (e.key === "Escape" && search) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearch("");
                  }
                }}
              />
              {async && fetching ? (
                <span className="exf-search__busy" role="status" aria-label="Searching">
                  <Icon name="loader" />
                </span>
              ) : null}
            </div>
          ) : null}
          {read.state === "error" ? (
            <p className="exf-note">
              Couldn’t load the counts.{" "}
              <button type="button" className="exf-link" onClick={retry}>
                Retry
              </button>
            </p>
          ) : async && waiting && local.length === 0 ? (
            <div className="exf-box exf-box--busy" aria-busy="true" aria-label={`Loading ${LABELS[field]} values`}>
              <Icon name="loader" />
            </div>
          ) : waiting && !async ? (
            <ul className="exf-list" aria-busy="true" aria-label={`${LABELS[field]} values`}>
              {[0, 1, 2].map((i) => (
                <li key={i} className="exf-item exf-item--skeleton">
                  <span className="exl-bone exf-bone-check" />
                  <span className="exl-bone" />
                </li>
              ))}
            </ul>
          ) : local.length === 0 ? (
            <div className="exf-empty">
              {needle ? (
                <>
                  <p className="exf-empty__title">No results found</p>
                  <p>Try a different search term</p>
                </>
              ) : (
                <p>No values in this range</p>
              )}
            </div>
          ) : (
            <ul className={`exf-list${async ? " exf-list--async" : ""}`} aria-label={`${LABELS[field]} values`} style={{ maxHeight: LIST_MAX }}>
              {local.map((v) => (
                <ValueRow
                  key={v.value}
                  label={label(v)}
                  value={v.value}
                  count={v.count}
                  checked={isOn(v.value)}
                  partial={field === "level" && levelState(q.conds, v.value as Level) === "partial"}
                  onSet={set}
                  onOnly={only}
                  mono={field === "method"}
                  body={field === "path" ? <PathText path={v.value} /> : field === "level" ? <LevelBody level={v.value as Level} /> : field === "status" ? <CodeBody code={v.value} /> : undefined}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** A path cut at the end, as Supabase's pathname option (UnifiedLogs.fields.tsx:121-126): clipping
 *  from the left put the hover "Only" over the tail too, cutting both ends. The full path is the row's title. */
function PathText({ path }: { path: string }) {
  return (
    <span className="exf-path">
      <bdi>{path}</bdi>
    </span>
  );
}

/**
 * The Level facet's rows: Supabase's three levels (DataTable.constants.ts LEVELS), each the sum of
 * the status codes it covers that pass the status exclusions (`statusConds`, the `≠` ones: ticked
 * codes refine a level, they do not shrink its count). Always all three, at 0 when empty.
 */
function levelValues(list: Values, statusConds: Cond[]): Values {
  const sum: Record<Level, number> = { success: 0, warning: 0, error: 0 };
  for (const v of list) {
    const code = Number(v.value);
    if (/^\d{3}$/.test(v.value) && statusHit(code, statusConds)) sum[levelOf(code)] += v.count;
  }
  return LEVELS.map((l) => ({ value: l, label: "", count: sum[l] }));
}

/**
 * A Level option (UnifiedLogs.fields.tsx `level` component): the level's name, then a 10px square
 * in its colour and the class it names (getLevelLabel: 2xx, 4xx, 5xx), in a 112px block.
 */
function LevelBody({ level }: { level: Level }) {
  return (
    <span className="exf-level">
      <span className="exf-level__name">{level}</span>
      <span className="exf-level__tag">
        <span className={`exf-swatch exf-swatch--${level}`} aria-hidden="true" />
        <span className="exf-level__cls">{LEVEL_CLASS[level]}</span>
      </span>
    </span>
  );
}

/** A Status option (UnifiedLogs.fields.tsx `status` component): the code in foreground and its
 *  reason phrase small and lighter. */
function CodeBody({ code }: { code: string }) {
  const phrase = /^\d{3}$/.test(code) ? reasonPhrase(Number(code)) : "";
  return (
    <span className="exf-code">
      <span className="exf-code__num">{code}</span>
      {phrase ? <span className="exf-code__phrase">{phrase}</span> : null}
    </span>
  );
}

function ValueRow({
  label,
  value,
  count,
  checked,
  onSet,
  onOnly,
  mono,
  body,
  partial = false,
}: {
  label: string;
  value: string;
  count: number;
  checked: boolean;
  /** Some of it ticked (a level with only some of its codes): the checkbox shows a dash. */
  partial?: boolean;
  onSet: (value: string, on: boolean) => void;
  onOnly: (value: string) => void;
  mono?: boolean;
  /** What the label shows in place of the plain text (the field's `component` in Supabase). */
  body?: ReactNode;
}) {
  const id = useId();
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = partial;
  }, [partial]);
  return (
    <li className={`exf-item${checked ? " is-checked" : ""}${partial ? " is-partial" : ""}`}>
      <span className="exf-check">
        <input ref={box} id={id} type="checkbox" checked={checked} onChange={(e) => onSet(value, e.target.checked)} />
        {partial ? <span className="exf-dash" aria-hidden="true" /> : <Icon name="check" />}
      </span>
      <label htmlFor={id} className={`exf-label${mono ? " is-mono" : ""}`} title={label}>
        {body ?? <span className="exf-label__text">{label}</span>}
      </label>
      <span className="exf-count" title={`${count.toLocaleString("en-US")} requests`}>
        {compactCount(count)}
      </span>
      <button type="button" className="exf-only" aria-label={`Only ${label}`} onClick={() => onOnly(value)}>
        Only
      </button>
    </li>
  );
}
