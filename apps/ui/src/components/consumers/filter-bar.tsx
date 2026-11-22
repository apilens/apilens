"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { type ConsumersQuery, consumersHref } from "@/lib/consumers";
import { Tip } from "../explore/tip";

/** The fields the consumers list can be narrowed by (all of them the consumers read takes). */
type Field = "env" | "group" | "app" | "method" | "path" | "q";
const FIELDS: { key: Field; label: string; op: string; mono?: boolean }[] = [
  { key: "q", label: "Username", op: "contains", mono: true },
  { key: "group", label: "Group", op: "=" },
  { key: "env", label: "Environment", op: "=" },
  { key: "app", label: "App", op: "=" },
  { key: "method", label: "Method", op: "=", mono: true },
  { key: "path", label: "Endpoint", op: "=", mono: true },
];

export type BarOption = { value: string; label: string; count?: number; detail?: string };
type Row = { key: string; text: string; detail?: string; mono?: boolean; head?: boolean; run: () => void };

/**
 * The Consumers filter bar, Traffic's and Explore's in look and keys. Focus it and the fields show
 * (Username, Group, Environment, App, Method, Endpoint); pick one and all its values show with
 * their counts (every group, every environment…), narrowed as you type; Enter or a click applies
 * it as a pill (`Group = Partners`). Typing before picking a field suggests across them: the
 * fields that match, "Username contains …", the matching usernames (which open their drawer) and
 * groups. A pill's body changes it, its × removes it; Backspace in the empty box selects the last
 * pill, again removes it; ← → move between pills; Esc steps back. `/` focuses it from anywhere.
 */
export function ConsumersFilterBar({
  project,
  query: q,
  values,
  users,
}: {
  project: string;
  query: ConsumersQuery;
  /** Each field's values (Username's are free text, its suggestions the `users`). */
  values: Record<Exclude<Field, "q">, BarOption[]>;
  /** The usernames the list shows, for suggestions. */
  users: { id: string; label: string; group: string }[];
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState(0);
  const [field, setField] = useState<Field | null>(null);
  const [hl, setHl] = useState<number | null>(null);

  const current: Record<Field, string> = { env: q.env, group: q.group ?? "", app: q.app, method: q.method, path: q.path, q: q.q };
  const label = (f: Field, v: string) => (f === "q" ? v : (values[f].find((o) => o.value === v)?.label ?? v));
  const pills = FIELDS.filter((f) => current[f.key]);

  const go = (patch: Partial<ConsumersQuery>) => {
    setText("");
    setField(null);
    setMenu(false);
    setHl(null);
    router.push(consumersHref(project, { ...q, consumer: null, ...patch }), { scroll: false });
  };
  const set = (f: Field, v: string) => go(f === "group" ? { group: v || null } : ({ [f]: v } as Partial<ConsumersQuery>));

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "/" || (e.key === "F" && e.shiftKey))) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function pick(f: Field) {
    setField(f);
    setText(f === "q" ? q.q : "");
    setActive(0);
    setMenu(true);
    setHl(null);
    input.current?.focus();
  }

  const t = text.trim().toLowerCase();
  const typed = text.trim();
  const userRows = (limit: number): Row[] =>
    users
      .filter((u) => !t || u.label.toLowerCase().includes(t) || u.id.toLowerCase().includes(t))
      .slice(0, limit)
      .map((u) => ({
        key: `u-${u.id}`,
        text: u.label,
        detail: u.group || undefined,
        mono: true,
        run: () => {
          setMenu(false);
          router.push(consumersHref(project, { ...q, consumer: u.id }), { scroll: false });
        },
      }));
  const valueRows = (f: Exclude<Field, "q">, limit = 60): Row[] =>
    values[f]
      .filter((o) => !t || o.label.toLowerCase().includes(t) || o.value.toLowerCase().includes(t))
      .slice(0, limit)
      .map((o) => ({
        key: `${f}-${o.value}`,
        text: o.label,
        detail: `${current[f] === o.value ? "✓ " : ""}${o.detail ?? (o.count !== undefined ? o.count.toLocaleString("en-US") : "")}` || undefined,
        mono: FIELDS.find((x) => x.key === f)?.mono,
        run: () => set(f, o.value),
      }));

  const rows: Row[] = field
    ? field === "q"
      ? [
          ...(typed ? [{ key: "q-typed", text: `Username contains “${typed}”`, detail: "apply", run: () => set("q", typed) }] : []),
          ...(users.length ? [{ key: "h-u", text: "Usernames", head: true, run: () => {} }] : []),
          ...userRows(20),
        ]
      : valueRows(field)
    : [
        ...FIELDS.filter((f) => !t || f.label.toLowerCase().includes(t)).map((f) => ({
          key: f.key,
          text: f.label,
          detail: current[f.key] ? label(f.key, current[f.key]) : undefined,
          run: () => pick(f.key),
        })),
        // Typed before picking a field: suggest across the values too.
        ...(typed ? [{ key: "q-typed", text: `Username contains “${typed}”`, detail: "search", run: () => set("q", typed) }] : []),
        ...(typed && userRows(5).length ? [{ key: "h-u", text: "Usernames", head: true, run: () => {} }, ...userRows(5)] : []),
        ...(typed && valueRows("group", 5).length ? [{ key: "h-g", text: "Groups", head: true, run: () => {} }, ...valueRows("group", 5)] : []),
      ];
  const pickable = rows.map((r, n) => (r.head ? -1 : n)).filter((n) => n >= 0);
  const at = pickable.includes(active) ? active : (pickable.find((n) => n >= active) ?? pickable[0] ?? -1);
  const step = (d: 1 | -1) => {
    const k = pickable.indexOf(at);
    const next = pickable[Math.max(0, Math.min(pickable.length - 1, k + d))];
    if (next !== undefined) setActive(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const empty = text === "";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!menu) return setMenu(true);
      return step(e.key === "ArrowDown" ? 1 : -1);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!field && empty && hl !== null) return pick(pills[hl].key);
      if (at >= 0) rows[at].run();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (hl !== null) return setHl(null);
      if (field) return setField(null);
      if (menu) return setMenu(false);
      if (text) return setText("");
      input.current?.blur();
      return;
    }
    if (e.key === "Backspace" && empty) {
      e.preventDefault();
      if (field) return setField(null);
      if (hl !== null) return set(pills[hl].key, "");
      if (pills.length) setHl(pills.length - 1);
      setMenu(false);
      return;
    }
    if (!field && empty && pills.length && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (e.key === "ArrowRight" && hl === null) return;
      e.preventDefault();
      setHl(e.key === "ArrowLeft" ? (hl === null ? pills.length - 1 : Math.max(0, hl - 1)) : hl !== null && hl < pills.length - 1 ? hl + 1 : null);
    }
  };

  const fieldDef = field ? FIELDS.find((f) => f.key === field) : null;
  const showMenu = menu && (rows.length > 0 || Boolean(field));
  const draft = fieldDef ? (
    <li className="exp-pill is-draft">
      <span className="exp-pill__seg exp-pill__field">{fieldDef.label}</span>
      <span className="exp-pill__seg exp-pill__op">{fieldDef.op}</span>
    </li>
  ) : null;

  return (
    <div className="exp tr-fbar">
      {pills.length || draft ? (
        <ul className="exp-pills" aria-label="Active filters">
          {pills.map((f, n) => {
            const words = `${f.label} ${f.op === "=" ? "is" : f.op} ${label(f.key, current[f.key])}`;
            return (
              <li key={f.key} className={`exp-pill${hl === n ? " is-hl" : ""}`}>
                <Tip label={`Change: ${words}`}>
                  <button type="button" className="exp-pill__body" aria-label={`Change filter: ${words}`} onClick={() => pick(f.key)}>
                    <span className="exp-pill__field">{f.label}</span>
                    <span className="exp-pill__op">{f.op}</span>
                    <span className={`exp-pill__value${f.mono ? " is-mono" : ""}`}>{label(f.key, current[f.key])}</span>
                  </button>
                </Tip>
                <Tip label="Remove filter">
                  <button type="button" className="exp-pill__x" aria-label={`Remove filter: ${words}`} onClick={() => set(f.key, "")}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                    </svg>
                  </button>
                </Tip>
              </li>
            );
          })}
          {draft}
        </ul>
      ) : null}
      <div className="exp-field">
        <input
          ref={input}
          className={`exp-input${fieldDef?.mono ? " is-mono" : ""}`}
          type="text"
          role="combobox"
          aria-label={fieldDef ? `Value for ${fieldDef.label}` : "Filter consumers"}
          aria-expanded={showMenu}
          aria-controls={`${id}-menu`}
          aria-autocomplete="list"
          aria-activedescendant={showMenu && at >= 0 ? `${id}-o-${at}` : undefined}
          aria-keyshortcuts="Shift+F /"
          placeholder={fieldDef ? `${fieldDef.label}…` : pills.length ? "Add filter…" : "Filter by Username, Group, Environment, App, Method, Endpoint…"}
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setHl(null);
            setMenu(true);
          }}
          onFocus={() => setMenu(true)}
          onBlur={() =>
            window.setTimeout(() => {
              setMenu(false);
              setHl(null);
              setField(null);
            }, 150)
          }
          onKeyDown={onKeyDown}
        />
        {showMenu ? (
          <ul className="exp-menu" id={`${id}-menu`} role="listbox" aria-label={fieldDef ? `${fieldDef.label} values` : "Fields"}>
            {fieldDef ? (
              <li className="exp-menu__head" role="presentation">
                {fieldDef.label} {fieldDef.op === "=" ? "is" : fieldDef.op}
              </li>
            ) : null}
            {rows.map((r, n) =>
              r.head ? (
                <li key={r.key} className="exp-menu__head" role="presentation">
                  {r.text}
                </li>
              ) : (
                <li
                  key={r.key}
                  id={`${id}-o-${n}`}
                  role="option"
                  aria-selected={n === at}
                  className={n === at ? "is-active" : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => n !== at && setActive(n)}
                  onClick={() => r.run()}
                >
                  <span className={`exp-menu__text${r.mono ? " is-mono" : ""}`}>{r.text}</span>
                  {r.detail ? <span className="exp-menu__count">{r.detail}</span> : null}
                </li>
              ),
            )}
            {fieldDef && rows.length === 0 ? (
              <li className="exp-menu__note" role="presentation">
                {text ? <>Nothing matches “{text}”.</> : <>No values in this range.</>}
              </li>
            ) : null}
            <li className="exp-menu__keys" role="presentation" aria-hidden="true">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> pick
              </span>
              <span>
                <kbd>⌫</kbd> {fieldDef ? "back" : "select pill"}
              </span>
              <span>
                <kbd>esc</kbd> close
              </span>
            </li>
          </ul>
        ) : null}
      </div>
      {pills.length ? (
        <Tip label="Clear all filters">
          <button type="button" className="exp-clear" onClick={() => go({ env: "", group: null, app: "", method: "", path: "", q: "" })}>
            Clear
          </button>
        </Tip>
      ) : null}
    </div>
  );
}
