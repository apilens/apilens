"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useState } from "react";
import { type TrafficState, trafficHref } from "@/lib/traffic";
import { METRIC_FIELDS, type MetricCond, type MetricField, type MetricOp, OP_SYMBOL, metricText, metricValueText, parseMetricInput } from "@/lib/traffic-metrics";

const PLACEHOLDER: Record<MetricField, string> = { client_errors: "10 or 2%", server_errors: "0 or 1%", p95: "500 ms", p50: "200 ms" };

/**
 * The sidebar's Endpoint metrics: per field (4xx, 5xx, p95, p50) an operator and a value, applied
 * with Enter or on leaving the box, cleared with × or an empty box. They are the URL's `?m=`
 * conditions, the same ones the filter bar's pills show, so both always agree.
 */
export function MetricFilters({ project, query: q }: { project: string; query: TrafficState }) {
  const router = useRouter();
  const conds = q.metrics ?? [];
  const set = (field: MetricField, c: MetricCond | null) => {
    const next = [...conds.filter((m) => m.field !== field), ...(c ? [c] : [])];
    router.push(trafficHref(project, { ...q, metrics: next }));
  };
  return (
    <div className="tr-mf">
      {METRIC_FIELDS.map((f) => (
        <Row key={f.key} field={f.key} label={f.label} cond={conds.find((c) => c.field === f.key) ?? null} onSet={(c) => set(f.key, c)} />
      ))}
    </div>
  );
}

function Row({ field, label, cond, onSet }: { field: MetricField; label: string; cond: MetricCond | null; onSet: (c: MetricCond | null) => void }) {
  const [op, setOp] = useState<MetricOp>(cond?.op ?? "gt");
  const [text, setText] = useState(cond ? metricValueText(cond) : "");
  const [bad, setBad] = useState(false);
  // The URL changed elsewhere (a pill removed, Reset): show what is in force.
  useEffect(() => {
    setOp(cond?.op ?? "gt");
    setText(cond ? metricValueText(cond) : "");
    setBad(false);
  }, [cond]);

  const apply = (nextOp = op) => {
    if (text.trim() === "") {
      setBad(false);
      if (cond) onSet(null);
      return;
    }
    const c = parseMetricInput(field, `${OP_SYMBOL[nextOp]}${text}`);
    if (!c) return setBad(true);
    setBad(false);
    if (!cond || cond.op !== c.op || cond.value !== c.value || cond.pct !== c.pct) onSet(c);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    } else if (e.key === "Escape") {
      setText(cond ? metricValueText(cond) : "");
      setBad(false);
      e.currentTarget.blur();
    }
  };
  const id = `tr-mf-${field}`;
  return (
    <div className={`tr-mf__row${cond ? " is-on" : ""}`}>
      <label htmlFor={id} className="tr-mf__label">
        {label}
      </label>
      <select
        className="tr-mf__op"
        aria-label={`${label}: comparison`}
        value={op}
        onChange={(e) => {
          const next = e.target.value as MetricOp;
          setOp(next);
          if (text.trim()) apply(next);
        }}
      >
        <option value="gt">&gt;</option>
        <option value="lt">&lt;</option>
        <option value="eq">=</option>
      </select>
      <input
        id={id}
        className="tr-mf__value"
        type="text"
        inputMode="decimal"
        placeholder={PLACEHOLDER[field]}
        value={text}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={bad || undefined}
        aria-describedby={bad ? `${id}-err` : undefined}
        title={cond ? `In force: ${metricText(cond)}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onBlur={() => apply()}
        onKeyDown={onKeyDown}
      />
      {cond ? (
        <button type="button" className="tr-mf__x" aria-label={`Remove ${metricText(cond)}`} onClick={() => onSet(null)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      ) : null}
      {bad ? (
        <p id={`${id}-err`} className="tr-mf__err" role="alert">
          {field === "p50" || field === "p95" ? "A time, like 500 ms or 1.5 s." : "A count, like 10, or a share, like 2%."}
        </p>
      ) : null}
    </div>
  );
}
