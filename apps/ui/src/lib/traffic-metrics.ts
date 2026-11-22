// Endpoint metric conditions for the Traffic page's endpoints table: `4xx > 2%`, `p95 > 500 ms`,
// `5xx = 0`. They live in the URL as `?m=<field>:<op>:<value>` (repeatable, one per field), so the
// sidebar, the filter bar and the table read one state. Pure; see traffic-metrics.test.ts.
import type { EndpointTraffic } from "./identity";

export type MetricField = "client_errors" | "server_errors" | "p50" | "p95";
export type MetricOp = "gt" | "lt" | "eq";

/** One condition. `pct` compares the share of the endpoint's requests (4xx and 5xx only). */
export interface MetricCond {
  field: MetricField;
  op: MetricOp;
  value: number;
  pct: boolean;
}

export const METRIC_FIELDS: readonly { key: MetricField; label: string; latency: boolean }[] = [
  { key: "client_errors", label: "4xx", latency: false },
  { key: "server_errors", label: "5xx", latency: false },
  { key: "p95", label: "p95", latency: true },
  { key: "p50", label: "p50", latency: true },
];

export const OP_SYMBOL: Record<MetricOp, string> = { gt: ">", lt: "<", eq: "=" };
const SYMBOL_OP: Record<string, MetricOp> = { ">": "gt", "<": "lt", "=": "eq" };

export const metricLabel = (f: MetricField) => METRIC_FIELDS.find((m) => m.key === f)?.label ?? f;
const isLatency = (f: MetricField) => f === "p50" || f === "p95";

/**
 * Reads what someone typed for a field: an operator (`>`, `<`, `=`; `>` when left out) then a
 * number. Latency takes `ms` or `s` (ms by default); 4xx and 5xx take a count, or a share with `%`.
 * Null when it isn't one of those.
 */
export function parseMetricInput(field: MetricField, text: string): MetricCond | null {
  const m = /^\s*([<>=])?\s*(\d+(?:\.\d+)?)\s*(ms|s|%)?\s*$/i.exec(text);
  if (!m) return null;
  const op = SYMBOL_OP[m[1] ?? ">"];
  const n = Number(m[2]);
  const unit = (m[3] ?? "").toLowerCase();
  if (!Number.isFinite(n)) return null;
  if (isLatency(field)) {
    if (unit === "%") return null;
    return { field, op, value: unit === "s" ? n * 1000 : n, pct: false };
  }
  if (unit === "ms" || unit === "s") return null;
  if (unit === "%" && n > 100) return null;
  return { field, op, value: n, pct: unit === "%" };
}

/** The URL form: `p95:gt:500`, `client_errors:gt:2%`. */
export function metricParam(c: MetricCond): string {
  return `${c.field}:${c.op}:${c.value}${c.pct ? "%" : ""}`;
}

/** Reads `?m=` values; unknown or malformed ones are dropped, and the last one per field wins. */
export function parseMetricParams(v: string | string[] | undefined): MetricCond[] {
  const byField = new Map<MetricField, MetricCond>();
  for (const raw of (Array.isArray(v) ? v : v ? [v] : []).slice(0, 16)) {
    const [field, op, value] = raw.split(":");
    if (!METRIC_FIELDS.some((f) => f.key === field) || !(op in OP_SYMBOL) || !value) continue;
    const c = parseMetricInput(field as MetricField, `${OP_SYMBOL[op as MetricOp]}${value}${isLatency(field as MetricField) && !/s$/.test(value) ? "ms" : ""}`);
    if (c) byField.set(c.field, c);
  }
  return METRIC_FIELDS.flatMap((f) => (byField.has(f.key) ? [byField.get(f.key) as MetricCond] : []));
}

/** The value in words: `500 ms`, `1.5 s`, `2%`, `10`. */
export function metricValueText(c: MetricCond): string {
  if (c.pct) return `${c.value}%`;
  if (isLatency(c.field)) return c.value >= 1000 && c.value % 100 === 0 ? `${c.value / 1000} s` : `${c.value} ms`;
  return String(c.value);
}

/** The condition in words, for pills and labels: `p95 > 500 ms`. */
export function metricText(c: MetricCond): string {
  return `${metricLabel(c.field)} ${OP_SYMBOL[c.op]} ${metricValueText(c)}`;
}

function actual(ep: EndpointTraffic, c: MetricCond): number {
  if (c.field === "p50") return ep.p50_ms;
  if (c.field === "p95") return ep.p95_ms;
  const n = c.field === "client_errors" ? ep.client_errors : ep.server_errors;
  return c.pct ? (ep.requests > 0 ? (n / ep.requests) * 100 : 0) : n;
}

/**
 * Whether an endpoint meets every condition. `=` on a share or a latency allows half a unit either
 * way (shares and times are rounded where they're shown), on a count it is exact.
 */
export function meetsMetrics(ep: EndpointTraffic, conds: readonly MetricCond[]): boolean {
  return conds.every((c) => {
    const a = actual(ep, c);
    if (c.op === "gt") return a > c.value;
    if (c.op === "lt") return a < c.value;
    return c.pct || isLatency(c.field) ? Math.abs(a - c.value) < 0.5 : a === c.value;
  });
}
