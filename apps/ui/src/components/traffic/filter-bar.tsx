"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { ExploreRange } from "@/lib/explore-query";
import type { NamedApp } from "@/lib/identity";
import { type TrafficState, appName, trafficHref } from "@/lib/traffic";
import { rangeIsSet } from "../explore/time-range";
import { Tip } from "../explore/tip";
import { TrafficTimePill } from "./time-range";

/** The fields Traffic can filter by: the ones its rollups are kept by, so every number follows. */
type Field = "env" | "app" | "method" | "path";
const FIELDS: { key: Field; label: string; mono?: boolean }[] = [
  { key: "env", label: "Environment" },
  { key: "app", label: "App" },
  { key: "method", label: "Method", mono: true },
  { key: "path", label: "Endpoint", mono: true },
];

type Option = { value: string; label: string; count?: number };

/**
 * Traffic's filter bar, Explore's in look and keys, over the fields every Traffic number can be
 * narrowed by (environment, app, method, endpoint). The scope is pills (`Method = POST`): click
 * one to change it, × to remove it. In the input, type to find a field, Enter, then type or pick
 * a value and Enter; Backspace in the empty input selects the last pill, again removes it; ← →
 * move between pills; Esc closes. `/` or ⇧F focuses it from anywhere. Each choice is a link, so
 * the scope stays in the URL.
 */
export function TrafficFilterBar({
  project,
  query: q,
  environments,
  apps,
  methods,
  paths,
}: {
  project: string;
  query: TrafficState;
  environments: readonly string[];
  apps: NamedApp[] | null;
  /** Methods and endpoint paths to suggest, with request counts where known. */
  methods: Option[];
  paths: Option[];
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState(0);
  const [field, setField] = useState<Field | null>(null);
  const [hl, setHl] = useState<number | null>(null);

  const current: Record<Field, string> = { env: q.env, app: q.app, method: q.method ?? "", path: q.path ?? "" };
  const pills = FIELDS.filter((f) => current[f.key]);
  const valueText = (f: Field, v: string) => (f === "app" ? (apps ? appName(apps, v) : v) : v);
  const go = (patch: Partial<TrafficState>) => {
    setText("");
    setField(null);
    setMenu(false);
    setHl(null);
    router.push(trafficHref(project, { ...q, ...patch }));
  };
  const set = (f: Field, v: string) => go({ [f]: v } as Partial<TrafficState>);

  // `/` or ⇧F focuses the bar, as in Explore; not while typing elsewhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" || (e.key === "F" && e.shiftKey)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const valuesOf = (f: Field): Option[] =>
    f === "env"
      ? environments.map((e) => ({ value: e, label: e }))
      : f === "app"
        ? (apps ?? []).map((a) => ({ value: a.id.toLowerCase(), label: a.name }))
        : f === "method"
          ? methods
          : paths;

  const t = text.trim().toLowerCase();
  const options: { key: string; text: string; detail?: string; mono?: boolean; run: () => void }[] = field
    ? valuesOf(field)
        .filter((o) => !t || o.label.toLowerCase().includes(t) || o.value.toLowerCase().includes(t))
        .slice(0, 50)
        .map((o) => ({
          key: o.value,
          text: o.label,
          detail: o.count !== undefined ? o.count.toLocaleString("en-US") : current[field] === o.value ? "current" : undefined,
          mono: FIELDS.find((x) => x.key === field)?.mono,
          run: () => set(field, o.value),
        }))
    : FIELDS.filter((f) => !t || f.label.toLowerCase().includes(t))
        .filter((f) => f.key !== "app" || (apps && apps.length > 1))
        .map((f) => ({ key: f.key, text: f.label, detail: current[f.key] ? valueText(f.key, current[f.key]) : undefined, run: () => pick(f.key) }));
  const at = Math.min(active, Math.max(0, options.length - 1));

  function pick(f: Field) {
    setField(f);
    setText("");
    setActive(0);
    setMenu(true);
    setHl(null);
    input.current?.focus();
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const empty = text === "";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!menu) return setMenu(true);
      setActive((a) => Math.max(0, Math.min(options.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!field && empty && hl !== null) return pick(pills[hl].key);
      options[at]?.run();
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
  // The range shows as a pill only while it is not the default 24 hours, as in Explore.
  const timeSet = rangeIsSet({ range: q.range as ExploreRange, from: q.from || undefined, to: q.to || undefined });
  const showMenu = menu && (options.length > 0 || Boolean(field));

  return (
    <div className="exp tr-fbar">
      {pills.length || timeSet ? (
        <ul className="exp-pills" aria-label="Active filters">
          <TrafficTimePill project={project} query={q} />
          {pills.map((f, n) => {
            const words = `${f.label} is ${valueText(f.key, current[f.key])}`;
            return (
              <li key={f.key} className={`exp-pill${hl === n ? " is-hl" : ""}`}>
                <Tip label={`Change: ${words}`}>
                  <button type="button" className="exp-pill__body" aria-label={`Change filter: ${words}`} onClick={() => pick(f.key)}>
                    <span className="exp-pill__field">{f.label}</span>
                    <span className="exp-pill__op">=</span>
                    <span className={`exp-pill__value${f.mono ? " is-mono" : ""}`}>{valueText(f.key, current[f.key])}</span>
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
          {fieldDef ? (
            <li className="exp-pill is-draft">
              <span className="exp-pill__seg exp-pill__field">{fieldDef.label}</span>
              <span className="exp-pill__seg exp-pill__op">=</span>
            </li>
          ) : null}
        </ul>
      ) : fieldDef ? (
        <ul className="exp-pills" aria-label="Filter being added">
          <li className="exp-pill is-draft">
            <span className="exp-pill__seg exp-pill__field">{fieldDef.label}</span>
            <span className="exp-pill__seg exp-pill__op">=</span>
          </li>
        </ul>
      ) : null}
      <div className="exp-field">
        <input
          ref={input}
          className={`exp-input${fieldDef?.mono ? " is-mono" : ""}`}
          type="text"
          role="combobox"
          aria-label={fieldDef ? `Value for ${fieldDef.label}` : "Filter traffic"}
          aria-expanded={showMenu}
          aria-controls={`${id}-menu`}
          aria-autocomplete="list"
          aria-activedescendant={showMenu && options[at] ? `${id}-o-${at}` : undefined}
          aria-keyshortcuts="Shift+F /"
          placeholder={fieldDef ? `${fieldDef.label}…` : pills.length ? "Add filter…" : "Filter by Environment, App, Method, Endpoint…"}
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
                {fieldDef.label} is
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
                {o.detail ? <span className="exp-menu__count">{o.detail}</span> : null}
              </li>
            ))}
            {fieldDef && options.length === 0 ? (
              <li className="exp-menu__note" role="presentation">
                Nothing matches “{text}”.
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
          <button type="button" className="exp-clear" onClick={() => go({ env: "", app: "", method: "", path: "" })}>
            Clear
          </button>
        </Tip>
      ) : null}
    </div>
  );
}
