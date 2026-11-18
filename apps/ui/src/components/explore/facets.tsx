"use client";

import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type Cond,
  type ExploreQuery,
  FACET_FIELDS,
  type FacetField,
  clearField,
  compactCount,
  onlyValue,
  routeSearch,
  termClass,
  ticked,
  toggleValue,
} from "@/lib/explore-query";
import { classWords, statusText } from "@/lib/http-status";
import { Icon } from "../icons";
import { useAppNames } from "./app-names";
import { isBool, useStored } from "./use-stored";

/** The facet sidebar's width in px: Supabase's 256 default and minimum, 512 at most. */
export const FACETS_MIN = 256;
export const FACETS_MAX = 512;
/** A list taller than this (px) scrolls, as Supabase's. */
const LIST_MAX = 215;
/** Lists with more values than this get a search box. */
const SEARCH_FROM = 4;
/** How long typed search waits before it asks the API. */
const SEARCH_DEBOUNCE_MS = 250;

const LABELS: Record<FacetField, string> = {
  status: "Status",
  app: "App",
  env: "Environment",
  method: "Method",
  path: "Path",
  consumer: "Consumer",
  consumer_group: "Consumer group",
};

/** Facets that ask the API as you type (their values are too many to list). */
const ASYNC: ReadonlySet<FacetField> = new Set(["path", "consumer"]);

type Values = { value: string; label: string; count: number }[];
type Read = { state: "loading" } | { state: "error" } | { state: "ok"; values: Values };

/**
 * The counts of one facet: requests per value under every other condition (the field's own are
 * left out, so ticking one value keeps the others), read when the facet is open and again when
 * the other conditions, the window or `refresh` change.
 */
function useFacetValues(project: string, q: ExploreQuery, field: FacetField, search: string, enabled: boolean, refresh: number): [Read, () => void] {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [retry, setRetry] = useState(0);
  const others = clearField(q.conds, field);
  const path = `/api/projects/${encodeURIComponent(project)}/requests/facets${routeSearch({ ...q, conds: others }, { field, ...(search ? { search } : {}) })}`;
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setRead((r) => (r.state === "ok" ? r : { state: "loading" }));
    const t = window.setTimeout(
      async () => {
        try {
          const res = await fetch(path, { signal: ctl.signal, cache: "no-store", headers: { accept: "application/json" } });
          const body = (await res.json().catch(() => null)) as { ok?: boolean; values?: Values; code?: string; next?: string } | null;
          if (res.status === 401 && body?.code === "session_expired") {
            window.location.assign(body.next ?? "/sign-in");
            return;
          }
          setRead(body?.ok ? { state: "ok", values: body.values ?? [] } : { state: "error" });
        } catch (err) {
          if ((err as Error).name !== "AbortError") setRead({ state: "error" });
        }
      },
      search ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [path, enabled, refresh, retry, search]);
  return [read, () => setRetry((n) => n + 1)];
}

const isOpenMap = (v: unknown): v is Record<string, boolean> => typeof v === "object" && v !== null && Object.values(v).every(isBool);

/**
 * Explore's facet sidebar (#1052, after Supabase's DataTableFilterCheckbox): Status, App,
 * Environment, Method, Path, Consumer and Consumer group, each a list of values with a checkbox
 * and the server's count (compact mono, 1.2k). Hovering a value swaps its count for "Only", which
 * keeps just that value. Ticking adds an `=` condition, so the facets and the filter bar's pills
 * are one filter set. Path and Consumer search the API as you type. Each facet has its own Reset;
 * the header's Reset clears every filter.
 */
export function FacetPanel({
  project,
  query: q,
  onChange,
  refresh,
  header,
}: {
  project: string;
  query: ExploreQuery;
  onChange: (conds: Cond[]) => void;
  refresh: number;
  /** The header's own controls (the sheet's Close on phones). */
  header?: ReactNode;
}) {
  const [open, setOpen] = useStored<Record<string, boolean>>("apilens.explore.facets.open", { status: true, app: true, env: true }, isOpenMap);
  return (
    <div className="exf">
      <div className="exf-head">
        <h2 className="exf-title">Filters</h2>
        {q.conds.length ? (
          <button type="button" className="exf-link" onClick={() => onChange([])}>
            Reset
          </button>
        ) : null}
        {header}
      </div>
      <div className="exf-scroll">
        {FACET_FIELDS.map((f) => (
          <Facet
            key={f}
            project={project}
            field={f}
            query={q}
            onChange={onChange}
            open={open[f] ?? q.conds.some((c) => c.field === f)}
            onToggle={() => setOpen((m) => ({ ...m, [f]: !(m[f] ?? q.conds.some((c) => c.field === f)) }))}
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
  field: FacetField;
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
  const [read, retry] = useFacetValues(project, q, field, async ? search.trim() : "", open, refresh);
  const selected = ticked(q.conds, field);
  const active = q.conds.filter((c) => c.field === field).length;

  const label = (v: { value: string; label: string }) => {
    if (field === "app") return appName(v.value) ?? `Unknown app ${v.value.slice(0, 8)}`;
    if (field === "consumer") return v.label.trim() || v.value;
    if (field === "status") return statusText(Number(v.value));
    return v.value;
  };

  // A ticked value the counts no longer list stays, at 0, so it can be unticked.
  const values: Values = useMemo(() => {
    if (read.state !== "ok") return [];
    const list = [...read.values];
    if (field !== "status") for (const s of selected) if (!list.some((v) => v.value === s)) list.unshift({ value: s, label: "", count: 0 });
    return list;
  }, [read, selected.join("\n"), field]);

  const needle = search.trim().toLowerCase();
  const local = !async && needle ? values.filter((v) => `${v.value} ${label(v)}`.toLowerCase().includes(needle)) : values;
  const searchable = async || (field !== "status" && values.length > SEARCH_FROM);

  const set = (value: string, on: boolean) => onChange(toggleValue(q.conds, field, value, on));
  const only = (value: string) => onChange(onlyValue(q.conds, field, value));

  return (
    <section className={`exf-facet${open ? " is-open" : ""}`} aria-labelledby={`${id}-h`}>
      <div className="exf-facet__head">
        <h3 className="exf-facet__title" id={`${id}-h`}>
          <button type="button" aria-expanded={open} aria-controls={`${id}-b`} onClick={onToggle}>
            <Icon name="chevronDown" />
            {LABELS[field]}
            {active ? <span className="exf-badge">{active}</span> : null}
          </button>
        </h3>
        {active ? (
          <button type="button" className="exf-link" aria-label={`Reset ${LABELS[field]}`} onClick={() => onChange(clearField(q.conds, field))}>
            Reset
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="exf-facet__body" id={`${id}-b`}>
          {searchable ? (
            <input
              type="search"
              className="exf-search"
              aria-label={`Search ${LABELS[field]}`}
              placeholder={async ? `Search ${LABELS[field].toLowerCase()}…` : "Search…"}
              value={search}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setSearch(e.target.value)}
            />
          ) : null}
          {read.state === "loading" ? (
            <ul className="exf-list" aria-busy="true" aria-label={`${LABELS[field]} values`}>
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="exf-item exf-item--skeleton">
                  <span className="exl-bone" />
                  <span className="exl-bone exf-bone-count" />
                </li>
              ))}
            </ul>
          ) : read.state === "error" ? (
            <p className="exf-note">
              Couldn’t load the counts.{" "}
              <button type="button" className="exf-link" onClick={retry}>
                Retry
              </button>
            </p>
          ) : field === "status" ? (
            <StatusList values={local} selected={selected} onSet={set} onOnly={only} labelId={`${id}-h`} />
          ) : local.length === 0 ? (
            <p className="exf-note">{needle ? "No values match." : "No values in this range."}</p>
          ) : (
            <ul className="exf-list" aria-label={`${LABELS[field]} values`} style={{ maxHeight: LIST_MAX }}>
              {local.map((v) => (
                <ValueRow key={v.value} label={label(v)} value={v.value} count={v.count} checked={selected.includes(v.value)} onSet={set} onOnly={only} mono={field === "path" || field === "method"} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Status: the classes (2xx, 4xx…) with their summed counts; each opens to its codes with reason phrases. */
function StatusList({
  values,
  selected,
  onSet,
  onOnly,
  labelId,
}: {
  values: Values;
  selected: string[];
  onSet: (value: string, on: boolean) => void;
  onOnly: (value: string) => void;
  labelId: string;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const classes = ["2xx", "3xx", "4xx", "5xx"];
  for (const v of values) {
    const c = termClass(v.value);
    if (c && !classes.includes(c)) classes.unshift(c);
  }
  for (const s of selected) {
    const c = termClass(s);
    if (c && !classes.includes(c)) classes.push(c);
  }
  return (
    <ul className="exf-list" aria-labelledby={labelId}>
      {classes.map((cls) => {
        const codes = values.filter((v) => termClass(v.value) === cls);
        const sum = codes.reduce((n, v) => n + v.count, 0);
        const isOpen = expanded.includes(cls);
        // Codes ticked on their own show even when the counts no longer list them.
        const extra = selected.filter((s) => termClass(s) === cls && s !== cls && !codes.some((v) => v.value === s));
        return (
          <li key={cls} className="exf-group">
            <ValueRow
              label={`${cls} ${classWords(cls)}`}
              value={cls}
              count={sum}
              checked={selected.includes(cls)}
              onSet={onSet}
              onOnly={onOnly}
              mono
              tag="div"
              lead={
                codes.length + extra.length ? (
                  <button
                    type="button"
                    className={`exf-expand${isOpen ? " is-open" : ""}`}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Hide" : "Show"} ${cls} codes`}
                    onClick={() => setExpanded((e) => (isOpen ? e.filter((x) => x !== cls) : [...e, cls]))}
                  >
                    <Icon name="chevronDown" />
                  </button>
                ) : (
                  <span className="exf-expand" />
                )
              }
            />
            {isOpen ? (
              <ul className="exf-sub" aria-label={`${cls} codes`}>
                {[...codes, ...extra.map((s) => ({ value: s, label: "", count: 0 }))].map((v) => (
                  <ValueRow
                    key={v.value}
                    label={/^\d{3}$/.test(v.value) ? statusText(Number(v.value)) : v.value}
                    value={v.value}
                    count={v.count}
                    checked={selected.includes(v.value)}
                    onSet={onSet}
                    onOnly={onOnly}
                    mono
                  />
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
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
  lead,
  tag: Tag = "li",
}: {
  tag?: "li" | "div";
  label: string;
  value: string;
  count: number;
  checked: boolean;
  onSet: (value: string, on: boolean) => void;
  onOnly: (value: string) => void;
  mono?: boolean;
  lead?: ReactNode;
}) {
  const id = useId();
  return (
    <Tag className={`exf-item${checked ? " is-checked" : ""}`}>
      {lead}
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onSet(value, e.target.checked)} />
      <label htmlFor={id} className={`exf-label${mono ? " is-mono" : ""}`} title={label}>
        {label}
      </label>
      <span className="exf-count" title={`${count.toLocaleString("en-US")} requests`}>
        {compactCount(count)}
      </span>
      <button type="button" className="exf-only" aria-label={`Only ${label}`} onClick={() => onOnly(value)}>
        Only
      </button>
    </Tag>
  );
}

/**
 * The sidebar's frame on wide screens: the panel at the remembered width with a handle on its edge
 * that drags it between 256 and 512px (arrow keys move it 16px).
 */
export function FacetSidebar({ width, onWidth, children }: { width: number; onWidth: (w: number) => void; children: ReactNode }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(FACETS_MIN, Math.min(FACETS_MAX, w)));
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onWidth(clamp(drag.current.w + e.clientX - drag.current.x));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
    if (!step) return;
    e.preventDefault();
    onWidth(clamp(width + step));
  };
  return (
    <aside className="exf-side" style={{ width }} aria-label="Filters">
      {children}
      <div
        className="exf-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize filters"
        aria-valuemin={FACETS_MIN}
        aria-valuemax={FACETS_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onKeyDown={onKeyDown}
      />
    </aside>
  );
}
