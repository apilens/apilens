"use client";

import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import {
  type Cond,
  type ExploreQuery,
  FACET_FIELDS,
  FIELDS,
  type FacetField,
  type FieldKey,
  LEVELS,
  type Level,
  OP_LABEL,
  OP_WORDS,
  type Op,
  clearField,
  compactCount,
  condWords,
  dedupe,
  fieldDef,
  levelCodes,
  makeCond,
  parseDuration,
  routeSearch,
  termLevel,
  tickedLevels,
  typedCond,
  typedTime,
  untickLevel,
  valueText,
} from "@/lib/explore-query";
import { type Values, SessionExpired, readFacetPage } from "./facets";
import { useAppNames } from "./app-names";
import { Tip } from "./tip";
import { type RangePick, TimeRangePill, rangeIsSet } from "./time-range";

/** One row of the suggestion list. `count` is the server's, for values. */
type Option = { key: string; text: string; detail?: string; count?: number; mono?: boolean; run: () => void };
/**
 * The condition being built (Supabase's FilterBar: property, then operator, then value). `index`
 * is the pill being edited, else null for a new one; `op` null while the operator is picked.
 */
type Draft = { index: number | null; field: FieldKey; op: Op | null };

/** How long typed value text waits before it asks the API (FilterBar's 300ms). */
const VALUE_DEBOUNCE_MS = 300;
/** Value suggestions per read. */
const VALUE_LIMIT = 20;
const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"];
const SAMPLED: Values = [
  { value: "true", label: "Kept in full", count: 0 },
  { value: "false", label: "Sampled out", count: 0 },
];
/** What can be typed for an operator, besides its label and words. */
const OP_ALIASES: Record<Op, string[]> = {
  eq: ["=", "==", "is", "eq"],
  neq: ["!=", "≠", "<>", "is not", "not", "neq"],
  contains: ["~", "contains", "has", "like"],
  ncontains: ["!~", "does not contain", "not contains", "excludes"],
  gt: [">", ">=", "≥", "at least", "gt"],
  lt: ["<", "<=", "≤", "at most", "lt"],
  between: ["..", "-", "between", "range"],
};

const isFacet = (f: FieldKey): f is FacetField => (FACET_FIELDS as readonly string[]).includes(f);

/**
 * The values to suggest for `field` (Supabase's async property options): Level and Sampling are
 * fixed; facet fields read the facets Route Handler (the busiest values under the other
 * conditions, with counts, cached with the sidebar's reads), searching as you type.
 */
function useValueOptions(project: string, q: ExploreQuery, field: FieldKey | null, search: string): { state: "idle" | "loading" | "error" | "ok"; values: Values } {
  const [read, setRead] = useState<{ key: string; state: "loading" | "error" | "ok"; values: Values } | null>(null);
  const key =
    field && isFacet(field)
      ? `/api/projects/${encodeURIComponent(project)}/requests/facets${routeSearch(
          { ...q, conds: clearField(q.conds, field) },
          { field, limit: String(VALUE_LIMIT), ...(search ? { search } : {}) },
        )}`
      : null;
  useEffect(() => {
    if (!key) return;
    let live = true;
    const t = window.setTimeout(
      () => {
        setRead((r) => (r?.key === key ? r : { key, state: "loading", values: r?.values ?? [] }));
        readFacetPage(key).then(
          (page) => live && setRead({ key, state: "ok", values: page.values }),
          (err) => {
            if (err instanceof SessionExpired) return window.location.assign(err.next);
            if (live) setRead({ key, state: "error", values: [] });
          },
        );
      },
      search ? VALUE_DEBOUNCE_MS : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [key, search]);

  if (field === "level") return { state: "ok", values: LEVELS.map((l) => ({ value: l, label: "", count: 0 })) };
  if (field === "sampled") return { state: "ok", values: SAMPLED };
  if (!key) return { state: "idle", values: [] };
  if (!read) return { state: "loading", values: [] };
  // While a new search loads, the last answer stays (filtered in the browser below).
  return { state: read.key === key ? read.state : "loading", values: read.values };
}

/**
 * Explore's filter bar (#1052), keyboard first after Supabase's FilterBar
 * (packages/ui-patterns/src/FilterBar): type to find a field, Enter, pick the operator, Enter,
 * then type or pick a value (the busiest ones, with counts) and Enter adds the pill. One field
 * operator is skipped. Typed shortcuts still work in one go (`status:500`, `method != GET`,
 * `latency > 500`, `time:2h`); other text is an Endpoint (path) `contains`.
 *
 * In the empty input: Backspace highlights the last pill and a second Backspace removes it; ← and
 * → move the highlight; Enter edits the highlighted pill; Esc clears it. Esc closes the list,
 * then clears the text, then leaves the bar. While building a pill,
 * Backspace in the empty input steps back (value → operator → field) and Esc drops the draft.
 * ↑/↓ move through the suggestions, Enter picks. ⇧F or / focuses the bar from anywhere.
 *
 * The time range lives in the sidebar's Time Range facet; while it differs from the default 24
 * hours a Time range pill leads the pills (TimeRangePill: click to change it, × to reset).
 */
export function PillBar({
  project,
  query,
  conds,
  onChange,
  onRange,
  inputRef,
}: {
  project: string;
  /** The page state, for the Time range pill and the value suggestions' window. */
  query: ExploreQuery;
  conds: Cond[];
  onRange: (r: RangePick) => void;
  onChange: (conds: Cond[]) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const menuRef = useRef<HTMLUListElement>(null);
  const appName = useAppNames();
  const names = { app: appName };
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The highlighted pill, as an index into `shown`. */
  const [hl, setHl] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const stage: "field" | "op" | "value" = draft === null ? "field" : draft.op === null ? "op" : "value";
  const t = text.trim();
  const valueField = stage === "value" && draft ? draft.field : null;
  const remote = useValueOptions(project, query, valueField, valueField && isFacet(valueField) ? t : "");

  // Level and Status are one hierarchy (explore-query.ts): a ticked level's codes are shown in its
  // pill (`Level = Warning › 404, 429`), not as pills of their own, and its × takes them along.
  const levels = tickedLevels(conds);
  const merged = (c: Cond) =>
    c.field === "status" &&
    c.op === "eq" &&
    c.value.split(",").every((v) => {
      const l = termLevel(v);
      return l !== null && levels.includes(l);
    });
  // The pill being edited leaves the row while its draft is built at the end; Esc puts it back.
  const shown = conds.map((c, i) => ({ c, i })).filter(({ c, i }) => !merged(c) && i !== draft?.index);
  const removeAt = (i: number) => {
    const c = conds[i];
    onChange(c.field === "level" && c.op === "eq" ? untickLevel(conds, c.value as Level) : conds.filter((_, j) => j !== i));
  };
  const pillValue = (c: Cond) => {
    const codes = c.field === "level" && c.op === "eq" ? levelCodes(conds, c.value as Level) : [];
    return codes.length ? `${valueText(c, names)} › ${codes.join(", ")}` : valueText(c, names);
  };

  const reset = (open = false) => {
    setDraft(null);
    setText("");
    setErr(null);
    setActive(0);
    setMenu(open);
  };
  const goto = (d: Draft | null, value = "") => {
    setDraft(d);
    setText(value);
    setErr(null);
    setActive(0);
    setMenu(true);
    setHl(null);
    inputRef.current?.focus();
  };
  const pickField = (field: FieldKey, index: number | null = null) => {
    const ops = fieldDef(field).ops;
    goto({ index, field, op: ops.length === 1 ? ops[0] : null });
  };
  const commit = (field: FieldKey, op: Op, raw: string) => {
    const c = makeCond(field, op, raw);
    if (!c) {
      const def = fieldDef(field);
      setErr(def.hint ?? `Enter a ${def.label.toLowerCase()}.`);
      setMenu(true);
      return;
    }
    const index = draft?.index ?? null;
    onChange(dedupe(index === null ? [...conds, c] : conds.map((x, i) => (i === index ? c : x))));
    reset();
  };
  const edit = (i: number) => {
    const c = conds[i];
    goto({ index: i, field: c.field, op: c.op }, c.value);
  };

  // The suggestions of the current stage.
  const options: Option[] = [];
  if (stage === "field") {
    const time = t ? typedTime(t) : null;
    const typed = t && !time && !/^(time|date)\s*[:=]/i.test(t) ? typedCond(t) : null;
    if (time) {
      const d = parseDuration(t.replace(/^(time|date)\s*[:=]\s*/i, ""));
      options.push({ key: "time", text: `Time range: ${d?.words ?? t}`, run: () => (onRange(time), reset()) });
    } else if (typed) {
      const freeform = typed.field === "path" && typed.op === "contains" && !/^path\b/i.test(t);
      options.push({ key: "typed", text: freeform ? `Endpoint contains “${typed.value}”` : condWords(typed, names), run: () => (onChange(dedupe([...conds, typed])), reset()) });
    }
    const lower = t.toLowerCase();
    if (!t || "time range".includes(lower) || "date".startsWith(lower)) options.push({ key: "time-range", text: "Time range", detail: "time:2h", run: () => goto(null, "time:") });
    for (const f of FIELDS) {
      if (t && !f.label.toLowerCase().includes(lower) && !f.key.includes(lower)) continue;
      options.push({ key: f.key, text: f.label, detail: f.ops.map((o) => OP_LABEL[o]).join(" "), run: () => pickField(f.key) });
    }
    // Fields whose name starts with the text go before an Endpoint search, so "sta" Enter picks Status;
    // a whole typed condition (`status:500`) stays first.
    if (t && !(typed && !(typed.field === "path" && typed.op === "contains" && !/^path\b/i.test(t)))) {
      const starts = (o: Option) => FIELDS.some((f) => f.key === o.key && (f.label.toLowerCase().startsWith(lower) || f.key.startsWith(lower)));
      const lead = options.filter(starts);
      if (lead.length) options.splice(0, options.length, ...lead, ...options.filter((o) => !starts(o)));
    }
  } else if (stage === "op" && draft) {
    const lower = t.toLowerCase();
    for (const o of fieldDef(draft.field).ops) {
      if (t && ![OP_LABEL[o], OP_WORDS[o], ...OP_ALIASES[o]].some((a) => a.toLowerCase().startsWith(lower))) continue;
      options.push({ key: o, text: OP_WORDS[o], detail: OP_LABEL[o] === OP_WORDS[o] ? undefined : OP_LABEL[o], run: () => goto({ ...draft, op: o }) });
    }
    // Text that is no operator is taken as the value of `=` (FilterBar's `Equals: "<typed>"`).
    if (t && !options.length) options.push({ key: "eq-typed", text: `${OP_WORDS[fieldDef(draft.field).ops[0]]} “${t}”`, run: () => commit(draft.field, fieldDef(draft.field).ops[0], t) });
  } else if (stage === "value" && draft?.op) {
    const { field, op } = draft;
    const def = fieldDef(field);
    const used = new Set(conds.filter((c, i) => c.field === field && c.op === op && i !== draft.index).map((c) => c.value));
    const lower = t.toLowerCase();
    const label = (v: { value: string; label: string }) => (field === "level" ? valueText({ field, op, value: v.value }, names) : v.label || valueText({ field, op, value: v.value }, names));
    let values = remote.values.filter((v) => !used.has(v.value));
    if (field === "status") values = [...STATUS_CLASSES.map((s) => ({ value: s, label: "", count: 0 })), ...values];
    if (t) values = values.filter((v) => v.value.toLowerCase().includes(lower) || label(v).toLowerCase().includes(lower));
    const exact = values.some((v) => v.value.toLowerCase() === lower);
    // Typed text is always the first choice (a `contains` takes it as typed), then the suggestions.
    if (t && !exact) options.push({ key: "typed", text: `“${t}”`, detail: "Enter", mono: def.mono, run: () => commit(field, op, t) });
    for (const v of values) {
      const shownLabel = label(v);
      options.push({
        key: `v:${v.value}`,
        text: shownLabel,
        detail: shownLabel !== v.value && field !== "level" && field !== "sampled" ? v.value.slice(0, 12) : undefined,
        count: v.count || undefined,
        mono: def.mono,
        run: () => commit(field, op, v.value),
      });
    }
  }
  const at = Math.min(active, Math.max(0, options.length - 1));

  // Keep the highlighted suggestion in view.
  useEffect(() => {
    menuRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [at, menu]);
  // A highlight past the end (a pill removed elsewhere) goes.
  useEffect(() => {
    if (hl !== null && hl >= shown.length) setHl(shown.length ? shown.length - 1 : null);
  }, [hl, shown.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const empty = text === "";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!menu) return setMenu(true);
      setActive((a) => (options.length ? Math.max(0, Math.min(options.length - 1, Math.min(a, options.length - 1) + (e.key === "ArrowDown" ? 1 : -1))) : 0));
      return;
    }
    if (e.key === "Escape") {
      if (hl !== null) {
        e.preventDefault();
        e.stopPropagation();
        return setHl(null);
      }
      if (draft) {
        e.preventDefault();
        e.stopPropagation();
        return reset();
      }
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        return setMenu(false);
      }
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        return setText("");
      }
      e.currentTarget.blur();
      return;
    }
    if (stage === "field" && empty && hl !== null && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      removeAt(shown[hl].i);
      setHl(hl > 0 ? hl - 1 : null);
      return;
    }
    if (e.key === "Backspace" && empty) {
      e.preventDefault();
      if (stage === "value" && draft) {
        const ops = fieldDef(draft.field).ops;
        return ops.length > 1 ? goto({ ...draft, op: null }) : reset(true);
      }
      if (stage === "op") return reset(true);
      if (shown.length) setHl(shown.length - 1);
      setMenu(false);
      return;
    }
    if (stage === "field" && empty && (e.key === "ArrowLeft" || e.key === "ArrowRight") && shown.length) {
      if (e.key === "ArrowRight" && hl === null) return;
      e.preventDefault();
      setMenu(false);
      setHl(e.key === "ArrowLeft" ? (hl === null ? shown.length - 1 : Math.max(0, hl - 1)) : hl! < shown.length - 1 ? hl! + 1 : null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (stage === "field" && empty && hl !== null) return edit(shown[hl].i);
      const o = menu || stage !== "field" ? options[at] : t ? options[0] : undefined;
      if (o) return o.run();
      // Nothing to pick: commit the typed value as it stands.
      if (stage === "value" && draft?.op) commit(draft.field, draft.op, t);
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && stage !== "field" && menu && options[at] && t) {
      e.preventDefault();
      options[at].run();
    }
  };

  const def = draft ? fieldDef(draft.field) : null;
  const placeholder =
    stage === "op" ? "Operator: = ≠ contains…" : stage === "value" && def ? (draft?.op === "between" ? "100-500" : (def.placeholder ?? "Value")) : conds.length ? "Add filter…" : "Filter by Time range, Level, Status, Endpoint…";
  const status =
    stage === "value" && (remote.state === "loading" || remote.state === "error") && !(options.length > (t ? 1 : 0))
      ? remote.state === "loading"
        ? "Loading values…"
        : "Couldn’t load values. Type one."
      : null;
  const showMenu = menu && (options.length > 0 || status !== null || err !== null);

  return (
    <div className="exp">
      <span className="exp-lead" aria-hidden="true" onClick={() => inputRef.current?.focus()}>
        <svg className="exp-icon" viewBox="0 0 16 16">
          <circle cx="7" cy="7" r="4.75" />
          <path d="M10.5 10.5L14 14" />
        </svg>
      </span>
      {shown.length || rangeIsSet(query) || draft ? (
        <ul className="exp-pills" aria-label="Active filters">
          <TimeRangePill query={query} onRange={onRange} />
          {shown.map(({ c, i }, n) => {
            const value = pillValue(c);
            const words = c.field === "level" && value !== valueText(c, names) ? `Level is ${value}` : condWords(c, names);
            return (
              <li key={`${c.field}:${c.op}:${c.value}`} className={`exp-pill${c.op === "neq" || c.op === "ncontains" ? " is-not" : ""}${hl === n ? " is-hl" : ""}`}>
                <Tip label={`Edit: ${words}`} keys={hl === n ? ["↵"] : undefined}>
                  <button type="button" className="exp-pill__body" aria-label={`Edit filter: ${words}`} onClick={() => edit(i)}>
                    <span className="exp-pill__field">{fieldDef(c.field).label}</span>
                    <span className="exp-pill__op">{OP_LABEL[c.op]}</span>
                    <span className={`exp-pill__value${fieldDef(c.field).mono ? " is-mono" : ""}`}>{value}</span>
                  </button>
                </Tip>
                <Tip label="Remove filter" keys={hl === n ? ["⌫"] : undefined}>
                  <button type="button" className="exp-pill__x" aria-label={`Remove filter: ${words}`} onClick={() => removeAt(i)}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                    </svg>
                  </button>
                </Tip>
              </li>
            );
          })}
          {draft && def ? (
            <li className="exp-pill is-draft">
              <button type="button" className="exp-pill__seg exp-pill__field" aria-label={`Change field (${def.label})`} onMouseDown={(e) => e.preventDefault()} onClick={() => goto(null)}>
                {def.label}
              </button>
              {draft.op ? (
                <button
                  type="button"
                  className="exp-pill__seg exp-pill__op"
                  aria-label={`Change operator (${OP_WORDS[draft.op]})`}
                  disabled={def.ops.length === 1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => goto({ ...draft, op: null })}
                >
                  {OP_LABEL[draft.op]}
                </button>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="exp-field">
        <input
          ref={inputRef}
          className={`exp-input${def?.mono && stage === "value" ? " is-mono" : ""}`}
          type="text"
          role="combobox"
          aria-label={stage === "field" ? "Filter requests" : stage === "op" && def ? `Operator for ${def.label}` : def ? `Value for ${def.label}` : "Filter requests"}
          aria-expanded={showMenu}
          aria-controls={`${id}-menu`}
          aria-autocomplete="list"
          aria-activedescendant={showMenu && options[at] ? `${id}-o-${at}` : undefined}
          aria-keyshortcuts="Shift+F /"
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `${id}-err` : undefined}
          placeholder={placeholder}
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setErr(null);
            setHl(null);
            setMenu(true);
          }}
          onFocus={() => setMenu(true)}
          onBlur={(e) => {
            if (e.relatedTarget && e.currentTarget.closest(".exp")?.contains(e.relatedTarget as Node)) return;
            window.setTimeout(() => {
              setMenu(false);
              setHl(null);
            }, 120);
          }}
          onKeyDown={onKeyDown}
        />
        {showMenu ? (
          <ul className="exp-menu" id={`${id}-menu`} ref={menuRef} role="listbox" aria-label={stage === "field" ? "Fields" : stage === "op" ? "Operators" : "Values"}>
            {stage !== "field" && def ? (
              <li className="exp-menu__head" role="presentation">
                {stage === "op" ? `${def.label}: pick an operator` : `${def.label} ${draft?.op ? OP_WORDS[draft.op] : ""}`}
              </li>
            ) : null}
            {options.map((o, i) => (
              <li
                key={o.key}
                id={`${id}-o-${i}`}
                role="option"
                aria-selected={i === at}
                className={i === at ? "is-active" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== at && setActive(i)}
                onClick={() => o.run()}
              >
                <span className={`exp-menu__text${o.mono ? " is-mono" : ""}`}>{o.text}</span>
                {o.count !== undefined ? <code className="exp-menu__count">{compactCount(o.count)}</code> : o.detail ? <span className="exp-menu__detail">{o.detail}</span> : null}
              </li>
            ))}
            {status ? (
              <li className="exp-menu__note" role="presentation">
                {status}
              </li>
            ) : null}
            {err ? (
              <li className="exp-menu__note is-error" id={`${id}-err`} role="presentation">
                {err}
              </li>
            ) : stage === "value" && def?.hint ? (
              <li className="exp-menu__note" role="presentation">
                {def.hint}
              </li>
            ) : null}
            <li className="exp-menu__keys" role="presentation" aria-hidden="true">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> {stage === "value" ? "add" : "pick"}
              </span>
              <span>
                <kbd>⌫</kbd> {stage === "field" ? "select pill" : "back"}
              </span>
              <span>
                <kbd>esc</kbd> {draft ? "cancel" : "close"}
              </span>
            </li>
          </ul>
        ) : null}
      </div>
      {conds.length ? (
        <Tip label="Clear all filters" keys={["F", "then", "C"]}>
          <button type="button" className="exp-clear" aria-keyshortcuts="F C" onClick={() => onChange([])}>
            Clear
          </button>
        </Tip>
      ) : null}
    </div>
  );
}
