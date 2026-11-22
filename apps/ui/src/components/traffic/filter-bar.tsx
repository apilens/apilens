"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { ExploreRange } from "@/lib/explore-query";
import type { NamedApp } from "@/lib/identity";
import { type TrafficState, appName, trafficHref } from "@/lib/traffic";
import { type MetricField, OP_SYMBOL, metricText, metricValueText, parseMetricInput } from "@/lib/traffic-metrics";
import { rangeIsSet } from "../explore/time-range";
import { Tip } from "../explore/tip";
import { TrafficTimePill } from "./time-range";

/**
 * The fields Traffic can filter by. The scope fields narrow every number (consumer from the raw
 * requests); the metric fields are conditions on the endpoints table's rows (`p95 > 500 ms`).
 */
type ScopeField = "env" | "app" | "method" | "path" | "consumer";
type Field = ScopeField | MetricField;
const FIELDS: { key: Field; label: string; mono?: boolean; metric?: boolean }[] = [
  { key: "env", label: "Environment" },
  { key: "app", label: "App" },
  { key: "method", label: "Method", mono: true },
  { key: "path", label: "Endpoint", mono: true },
  { key: "consumer", label: "Consumer" },
  { key: "requests", label: "Requests", metric: true },
  { key: "client_errors", label: "4xx", metric: true },
  { key: "server_errors", label: "5xx", metric: true },
  { key: "p95", label: "p95", metric: true },
  { key: "p50", label: "p50", metric: true },
];
const isMetric = (f: Field): f is MetricField => f === "requests" || f === "client_errors" || f === "server_errors" || f === "p95" || f === "p50";
/** The value stage's hint for a metric field. */
const METRIC_HINT: Record<MetricField, string> = { requests: "> 1000, < 50", client_errors: "> 10, < 2%, = 0", server_errors: "> 0, < 1%", p95: "> 500 ms, < 1.5 s", p50: "> 200 ms" };

type Option = { value: string; label: string; count?: number };

/**
 * Traffic's filter bar, Explore's in look and keys, over the fields every Traffic number can be
 * narrowed by (environment, app, method, endpoint, consumer) and the endpoints table's metric
 * conditions (4xx, 5xx, p95, p50: `p95 > 500 ms`). The scope is pills (`Method = POST`): click
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
  consumers = [],
}: {
  project: string;
  query: TrafficState;
  environments: readonly string[];
  apps: NamedApp[] | null;
  /** Methods and endpoint paths to suggest, with request counts where known. */
  methods: Option[];
  paths: Option[];
  /** Consumers to suggest (id, name, requests). */
  consumers?: Option[];
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState(0);
  const [field, setField] = useState<Field | null>(null);
  const [hl, setHl] = useState<number | null>(null);

  const current: Record<ScopeField, string> = { env: q.env, app: q.app, method: q.method ?? "", path: q.path ?? "", consumer: q.consumer ?? "" };
  const metrics = q.metrics ?? [];
  const valueText = (f: ScopeField, v: string) =>
    f === "app" ? (apps ? appName(apps, v) : v) : f === "consumer" ? (consumers.find((c) => c.value === v)?.label ?? v) : v;
  // Every condition in force as one pill: the scope's, then the metric conditions.
  const pills: { key: Field; label: string; op: string; value: string; mono?: boolean }[] = [
    ...FIELDS.flatMap((f) => (!isMetric(f.key) && current[f.key as ScopeField] ? [{ key: f.key, label: f.label, op: "=", value: valueText(f.key as ScopeField, current[f.key as ScopeField]), mono: f.mono }] : [])),
    ...metrics.map((m) => ({ key: m.field as Field, label: FIELDS.find((f) => f.key === m.field)?.label ?? m.field, op: OP_SYMBOL[m.op], value: metricValueText(m) })),
  ];
  const go = (patch: Partial<TrafficState>) => {
    setText("");
    setField(null);
    setMenu(false);
    setHl(null);
    router.push(trafficHref(project, { ...q, ...patch }));
  };
  const set = (f: ScopeField, v: string) => go({ [f]: v } as Partial<TrafficState>);
  const remove = (f: Field) => (isMetric(f) ? go({ metrics: metrics.filter((m) => m.field !== f) }) : set(f, ""));

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

  const valuesOf = (f: ScopeField): Option[] =>
    f === "env"
      ? environments.map((e) => ({ value: e, label: e }))
      : f === "app"
        ? (apps ?? []).map((a) => ({ value: a.id.toLowerCase(), label: a.name }))
        : f === "method"
          ? methods
          : f === "consumer"
            ? consumers
            : paths;
  // A metric field's value stage: what was typed, read as a condition (`> 500 ms`), else the
  // operators to start one with.
  const metricOptions = (f: MetricField) => {
    const c = text.trim() ? parseMetricInput(f, text) : null;
    if (c) return [{ key: "apply", text: metricText(c), detail: "apply", run: () => go({ metrics: [...metrics.filter((m) => m.field !== f), c] }) }];
    return (["gt", "lt", "eq"] as const).map((op) => ({
      key: op,
      text: `${OP_SYMBOL[op]} ${op === "gt" ? "greater than" : op === "lt" ? "less than" : "equal to"}`,
      detail: undefined as string | undefined,
      run: () => {
        setText(`${OP_SYMBOL[op]} `);
        input.current?.focus();
      },
    }));
  };

  const t = text.trim().toLowerCase();
  const options: { key: string; text: string; detail?: string; mono?: boolean; run: () => void }[] = field
    ? isMetric(field)
      ? metricOptions(field)
      : valuesOf(field)
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
        .map((f) => {
          const on = pills.find((p) => p.key === f.key);
          return { key: f.key, text: f.metric ? `${f.label} (endpoints)` : f.label, detail: on ? `${on.op === "=" ? "" : `${on.op} `}${on.value}` : undefined, run: () => pick(f.key) };
        });
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
      if (hl !== null) return remove(pills[hl].key);
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
            const words = `${f.label} ${f.op === "=" ? "is" : f.op} ${f.value}`;
            return (
              <li key={f.key} className={`exp-pill${hl === n ? " is-hl" : ""}`}>
                <Tip label={`Change: ${words}`}>
                  <button type="button" className="exp-pill__body" aria-label={`Change filter: ${words}`} onClick={() => pick(f.key)}>
                    <span className="exp-pill__field">{f.label}</span>
                    <span className="exp-pill__op">{f.op}</span>
                    <span className={`exp-pill__value${f.mono ? " is-mono" : ""}`}>{f.value}</span>
                  </button>
                </Tip>
                <Tip label="Remove filter">
                  <button type="button" className="exp-pill__x" aria-label={`Remove filter: ${words}`} onClick={() => remove(f.key)}>
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
              {fieldDef.metric ? null : <span className="exp-pill__seg exp-pill__op">=</span>}
            </li>
          ) : null}
        </ul>
      ) : fieldDef ? (
        <ul className="exp-pills" aria-label="Filter being added">
          <li className="exp-pill is-draft">
            <span className="exp-pill__seg exp-pill__field">{fieldDef.label}</span>
            {fieldDef.metric ? null : <span className="exp-pill__seg exp-pill__op">=</span>}
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
          placeholder={fieldDef ? (isMetric(fieldDef.key) ? METRIC_HINT[fieldDef.key] : `${fieldDef.label}…`) : pills.length ? "Add filter…" : "Filter by Environment, Method, Endpoint, Consumer, Requests, 4xx, p95…"}
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
                {isMetric(fieldDef.key) ? `Endpoints where ${fieldDef.label} is` : `${fieldDef.label} is`}
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
                {isMetric(fieldDef.key) ? `Not a value for ${fieldDef.label}: try ${METRIC_HINT[fieldDef.key]}.` : `Nothing matches “${text}”.`}
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
          <button type="button" className="exp-clear" onClick={() => go({ env: "", app: "", method: "", path: "", consumer: "", metrics: [] })}>
            Clear
          </button>
        </Tip>
      ) : null}
    </div>
  );
}
