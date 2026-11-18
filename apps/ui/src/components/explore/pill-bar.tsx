"use client";

import { type FormEvent, type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { METHODS } from "@/lib/explore-filters";
import { type Cond, type ExploreQuery, FIELDS, type FieldKey, OP_LABEL, type Op, condWords, dedupe, fieldDef, makeCond, parseDuration, typedCond, typedTime, valueText } from "@/lib/explore-query";
import type { NamedApp } from "@/lib/identity";
import { PopMenu } from "../pop-menu";
import { useAppNames } from "./app-names";
import { type RangePick, TimePill } from "./range-menu";

type Option = { key: string; text: string; detail?: string; run: () => void };
type Editing = { index: number | null; field: FieldKey; op: Op; value: string };

const STATUS_SUGGEST = ["2xx", "3xx", "4xx", "5xx", "400", "401", "403", "404", "409", "422", "429", "500", "502", "503", "504"];

/**
 * Explore's filter bar (#1052, after Supabase's LogsFilterBar): the conditions as pills of
 * `field · operator · value`. Click a pill to edit it, × to remove it, Backspace in the empty input
 * removes the last one. Focusing the input lists the fields to filter by; typed text becomes a
 * condition on Enter (`status:500`, `method != GET`, `latency > 500`), anything else a path
 * `contains`. The facets edit the same list, so ticking a value adds its `=` pill.
 *
 * The time range is the box's first pill (#1061, as Supabase's LogsFilterBar keeps its `date`
 * condition in the FilterBar): click it for the date picker, or type `time:2h` / `date:24h`.
 * Markup and sizes after ui-patterns FilterBar (FilterBar.tsx:61-98, FilterCondition.tsx:278-488):
 * a bordered box with a 16px search icon, 26px pills, 12px text.
 */
export function PillBar({
  conds,
  onChange,
  query,
  onRange,
  inputRef,
  apps,
  environments,
}: {
  conds: Cond[];
  query: ExploreQuery;
  onRange: (r: RangePick) => void;
  onChange: (conds: Cond[]) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  apps: readonly NamedApp[] | null;
  environments: readonly string[];
}) {
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const appName = useAppNames();
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const names = { app: appName };

  const add = (c: Cond) => onChange(dedupe([...conds, c]));
  const startEdit = (field: FieldKey, index: number | null = null) => {
    const c = index === null ? null : conds[index];
    setEditing({ index, field, op: c?.op ?? fieldDef(field).ops[0], value: c?.value ?? "" });
    setMenu(false);
    setText("");
  };

  const t = text.trim();
  const time = t ? typedTime(t, Date.now()) : null;
  const typed = t && !time && !/^(time|date)\s*[:=]/i.test(t) ? typedCond(t) : null;
  const options: Option[] = [];
  if (time) {
    const d = parseDuration(t.replace(/^(time|date)\s*[:=]\s*/i, ""));
    options.push({
      key: "time",
      text: `Time range: ${d?.words ?? t}`,
      detail: "Enter",
      run: () => {
        onRange(time);
        setText("");
      },
    });
  } else if (t && typed) {
    options.push({
      key: "typed",
      text: typed.field === "path" && typed.op === "contains" && !/^path\b/i.test(t) ? `Path contains “${typed.value}”` : condWords(typed, names),
      detail: "Enter",
      run: () => {
        add(typed);
        setText("");
      },
    });
  }
  if (!t || "time range".includes(t.toLowerCase()) || "date".startsWith(t.toLowerCase())) {
    options.push({ key: "time-range", text: "Time range", detail: "time:2h", run: () => setText("time:") });
  }
  for (const f of FIELDS) {
    if (t && !f.label.toLowerCase().includes(t.toLowerCase()) && !f.key.includes(t.toLowerCase())) continue;
    options.push({ key: f.key, text: f.label, detail: f.ops.map((o) => OP_LABEL[o]).join(" "), run: () => startEdit(f.key) });
  }
  const at = Math.min(active, Math.max(0, options.length - 1));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && text === "" && conds.length) {
      e.preventDefault();
      onChange(conds.slice(0, -1));
      return;
    }
    if (e.key === "Escape") {
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        setMenu(false);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setMenu(true);
      setActive((a) => (options.length ? (a + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const o = menu ? options[at] : typed || time ? options[0] : undefined;
      o?.run();
    }
  };

  return (
    <div className="exp" ref={bar}>
      <span className="exp-lead" aria-hidden="true" onClick={() => inputRef.current?.focus()}>
        <svg className="exp-icon" viewBox="0 0 16 16">
          <circle cx="7" cy="7" r="4.75" />
          <path d="M10.5 10.5L14 14" />
        </svg>
      </span>
      <ul className="exp-pills" aria-label="Active filters">
          <TimePill query={query} onRange={onRange} />
          {conds.map((c, i) => {
            const words = condWords(c, names);
            return (
              <li key={`${c.field}:${c.op}:${c.value}`} className={`exp-pill${c.op === "neq" || c.op === "ncontains" ? " is-not" : ""}`}>
                <button type="button" className="exp-pill__body" aria-label={`Edit filter: ${words}`} title={words} onClick={() => startEdit(c.field, i)}>
                  <span className="exp-pill__field">{fieldDef(c.field).label}</span>
                  <span className="exp-pill__op">{OP_LABEL[c.op]}</span>
                  <span className={`exp-pill__value${fieldDef(c.field).mono ? " is-mono" : ""}`}>{valueText(c, names)}</span>
                </button>
                <button type="button" className="exp-pill__x" aria-label={`Remove filter: ${words}`} onClick={() => onChange(conds.filter((_, j) => j !== i))}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                  </svg>
                </button>
              </li>
            );
          })}
      </ul>
      <div className="exp-field">
        <input
          ref={inputRef}
          className="exp-input"
          type="text"
          role="combobox"
          aria-label="Filter requests"
          aria-expanded={menu && options.length > 0}
          aria-controls={`${id}-menu`}
          aria-autocomplete="list"
          aria-activedescendant={menu && options[at] ? `${id}-o-${options[at].key}` : undefined}
          placeholder={conds.length ? "Add filter…" : "Search or filter… (Shift+F)"}
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setMenu(true);
          }}
          onFocus={() => setMenu(true)}
          onBlur={() => window.setTimeout(() => setMenu(false), 120)}
          onKeyDown={onKeyDown}
        />
        {menu && options.length ? (
          <ul className="exp-menu" id={`${id}-menu`} role="listbox" aria-label="Filter fields">
            {options.map((o, i) => (
              <li
                key={o.key}
                id={`${id}-o-${o.key}`}
                role="option"
                aria-selected={i === at}
                className={i === at ? "is-active" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => o.run()}
              >
                <span>{o.text}</span>
                {o.detail ? <span className="exp-menu__detail">{o.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {conds.length ? (
        <button type="button" className="exp-clear" onClick={() => onChange([])} title="Clear all filters (F then C)">
          Clear
        </button>
      ) : null}
      <PillEditor
        editing={editing}
        anchor={bar}
        apps={apps}
        environments={environments}
        onCancel={() => {
          setEditing(null);
          inputRef.current?.focus();
        }}
        onApply={(c) => {
          if (!editing) return;
          if (editing.index === null) add(c);
          else onChange(dedupe(conds.map((x, i) => (i === editing.index ? c : x))));
          setEditing(null);
          inputRef.current?.focus();
        }}
      />
    </div>
  );
}

/** The pill editor: the field's operators and its value, with suggestions where the values are known. */
function PillEditor({
  editing,
  anchor,
  apps,
  environments,
  onCancel,
  onApply,
}: {
  editing: Editing | null;
  anchor: RefObject<HTMLDivElement | null>;
  apps: readonly NamedApp[] | null;
  environments: readonly string[];
  onCancel: () => void;
  onApply: (c: Cond) => void;
}) {
  const id = useId();
  const [op, setOp] = useState<Op>("eq");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    setOp(editing.op);
    setValue(editing.field === "app" && !editing.value ? (apps?.[0]?.id.toLowerCase() ?? "") : editing.field === "sampled" && !editing.value ? "true" : editing.value);
    setErr(null);
    const f = requestAnimationFrame(() => document.getElementById(`${id}-value`)?.focus());
    return () => cancelAnimationFrame(f);
  }, [editing, id, apps]);

  if (!editing) return null;
  const def = fieldDef(editing.field);
  const suggestions =
    editing.field === "method" ? [...METHODS] : editing.field === "env" ? environments : editing.field === "status" ? STATUS_SUGGEST : [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = makeCond(editing.field, op, value);
    if (!c) {
      setErr(def.hint ?? `Enter a ${def.label.toLowerCase()}.`);
      return;
    }
    onApply(c);
  };

  return (
    <PopMenu open onClose={onCancel} triggerRef={anchor} label={`Filter by ${def.label}`} role="dialog" id={`${id}-pop`}>
      <form className="exp-edit" onSubmit={submit} noValidate>
        <p className="exp-edit__field">{def.label}</p>
        {def.ops.length > 1 ? (
          <div className="exp-edit__ops" role="radiogroup" aria-label="Operator">
            {def.ops.map((o) => (
              <button key={o} type="button" role="radio" aria-checked={op === o} className="exp-edit__op" onClick={() => setOp(o)}>
                {OP_LABEL[o]}
              </button>
            ))}
          </div>
        ) : null}
        <label className="ex-sr" htmlFor={`${id}-value`}>
          Value
        </label>
        {editing.field === "app" ? (
          <select id={`${id}-value`} className="ex-input" value={value} onChange={(e) => setValue(e.target.value)}>
            {(apps ?? []).map((a) => (
              <option key={a.id} value={a.id.toLowerCase()}>
                {a.name}
              </option>
            ))}
            {value && !(apps ?? []).some((a) => a.id.toLowerCase() === value) ? <option value={value}>Unknown app {value.slice(0, 8)}</option> : null}
          </select>
        ) : editing.field === "sampled" ? (
          <select id={`${id}-value`} className="ex-input" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="true">Kept in full</option>
            <option value="false">Sampled out</option>
          </select>
        ) : (
          <>
            <input
              id={`${id}-value`}
              className={`ex-input${def.mono ? " ex-input--mono" : ""}`}
              value={value}
              placeholder={op === "between" ? "100-500" : def.placeholder}
              list={suggestions.length ? `${id}-list` : undefined}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? `${id}-err` : def.hint ? `${id}-hint` : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setErr(null);
              }}
            />
            {suggestions.length ? (
              <datalist id={`${id}-list`}>
                {suggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            ) : null}
          </>
        )}
        {err ? (
          <p className="ex-error" id={`${id}-err`} role="alert">
            {err}
          </p>
        ) : def.hint ? (
          <p className="ex-hint" id={`${id}-hint`}>
            {def.hint}
          </p>
        ) : null}
        <div className="ex-views__actions">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="ah-btn ah-btn--primary ah-btn--sm">
            {editing.index === null ? "Add filter" : "Apply"}
          </button>
        </div>
      </form>
    </PopMenu>
  );
}
