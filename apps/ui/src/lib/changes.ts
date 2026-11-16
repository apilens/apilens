// The Changes view (#597): every deploy of the project with its error rate and p95 in the hour
// before and the hour after, and whether that moved enough to call out. Pure helpers, so the
// thresholds and the copy are unit-tested (changes.test.ts).
import { isoSecond } from "./explore-timeline";
import { formatCount } from "./first-data";
import type { DeployChange, DeployEndpoint, DeploySide, QueryRange } from "./identity";

/** The deploys the view lists: the last seven days, newest first. */
export const CHANGES_RANGE: QueryRange = "7d";
export const CHANGES_LIMIT = 25;

/** `worse` and `better` are colored (error / ok tokens); `flat` and `none` are not. */
export type DeltaTone = "worse" | "better" | "flat" | "none";

export interface Delta {
  tone: DeltaTone;
  /** e.g. `+1.4 pp`, `−32 ms (−18%)`; empty when there is nothing to compare. */
  text: string;
}

/** An error-rate move smaller than this (in percentage points) is noise. */
export const ERROR_RATE_STEP_PP = 0.5;
/** A p95 move must pass both of these to count: relative and absolute. */
export const P95_STEP_RATIO = 0.1;
export const P95_STEP_MS = 5;

const MINUS = "−";
const signed = (n: number, digits: number) => {
  const abs = Math.abs(n).toFixed(digits);
  if (Number(abs) === 0) return `±${(0).toFixed(digits)}`;
  return `${n > 0 ? "+" : MINUS}${abs}`;
};

const comparable = (before: DeploySide, after: DeploySide) => before.requests > 0 && after.requests > 0;

/** The error-rate change across a deploy, in percentage points. */
export function errorRateDelta(before: DeploySide, after: DeploySide): Delta {
  if (!comparable(before, after)) return { tone: "none", text: "" };
  const pp = (after.error_rate - before.error_rate) * 100;
  const tone: DeltaTone = pp >= ERROR_RATE_STEP_PP ? "worse" : pp <= -ERROR_RATE_STEP_PP ? "better" : "flat";
  return { tone, text: `${signed(pp, 1)} pp` };
}

/** The p95 change across a deploy, in milliseconds and relative to before. */
export function p95Delta(before: DeploySide, after: DeploySide): Delta {
  if (!comparable(before, after) || before.p95_ms <= 0) return { tone: "none", text: "" };
  const ms = after.p95_ms - before.p95_ms;
  const ratio = ms / before.p95_ms;
  const tone: DeltaTone =
    ratio >= P95_STEP_RATIO && ms >= P95_STEP_MS ? "worse" : ratio <= -P95_STEP_RATIO && ms <= -P95_STEP_MS ? "better" : "flat";
  return { tone, text: `${signed(Math.round(ms), 0)} ms (${signed(Math.round(ratio * 100), 0)}%)` };
}

/** An error rate (0..1) as a percentage: `0%`, `<0.1%`, `2.4%`. */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0%";
  if (rate < 0.001) return "<0.1%";
  return `${(rate * 100).toFixed(1)}%`;
}

/** One side's error rate for the table, or a dash without traffic. */
export function sideRate(side: DeploySide): string {
  return side.requests > 0 ? formatRate(side.error_rate) : "–";
}

/** One side's p95 for the table, or a dash without traffic. */
export function sideP95(side: DeploySide): string {
  if (side.requests <= 0) return "–";
  const ms = side.p95_ms;
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** A commit as people read it: the first seven characters of a SHA, anything else as given. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{8,}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

const MINUTE = 60_000;
const minuteOf = (iso: string) => Math.floor(Date.parse(iso) / MINUTE) * MINUTE;

/** The smallest range ending now that still reaches back to `fromMs`; 7d when none does. */
export function rangeCovering(fromMs: number, now: number): QueryRange {
  const spans: [QueryRange, number][] = [
    ["1h", 60 * MINUTE],
    ["6h", 6 * 60 * MINUTE],
    ["24h", 24 * 60 * MINUTE],
  ];
  for (const [r, span] of spans) if (now - fromMs <= span) return r;
  return "7d";
}

/**
 * Explore over one side of a deploy, in the deploy's environment: `after` is the hour after the
 * deploy's minute (up to now), `before` the hour before it. Explore has no release filter, so the
 * time window is what narrows it. The range is the smallest that holds the window.
 */
export function exploreHref(project: string, d: Pick<DeployChange, "deployed_at" | "environment">, now: number, side: "after" | "before" = "after"): string {
  const minute = minuteOf(d.deployed_at);
  const from = side === "after" ? minute + MINUTE : minute - 60 * MINUTE;
  const to = side === "after" ? Math.min(minute + 61 * MINUTE, Math.floor(now / MINUTE) * MINUTE + MINUTE) : minute;
  const q = new URLSearchParams();
  q.set("range", rangeCovering(from, now));
  q.set("from", isoSecond(from));
  q.set("to", isoSecond(Math.max(to, from + MINUTE)));
  if (d.environment) q.set("env", d.environment);
  return `/${encodeURIComponent(project)}/explore?${q.toString()}`;
}

/** The deploy's own page. */
export function deployHref(project: string, id: string): string {
  return `/${encodeURIComponent(project)}/changes/${encodeURIComponent(id)}`;
}

/** The list's filters: an app id and an environment, empty for all. */
export interface ChangesFilter {
  app: string;
  env: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads `?app=&env=`; an app that is not a UUID or an environment over 64 characters is ignored. */
export function parseChangesFilter(params: Params): ChangesFilter {
  const app = (one(params.app) ?? "").trim();
  const env = (one(params.env) ?? "").trim();
  return { app: UUID_RE.test(app) ? app.toLowerCase() : "", env: env.length <= 64 ? env : "" };
}

/** The deploy page sizes: each deploy costs the API one rollup read, so at most 50. */
export const CHANGES_PAGE_SIZES: readonly number[] = [25, 50];

/** Fewer requests than this on either side and a verdict would be a guess. */
export const MIN_COMPARE_REQUESTS = 20;

export type VerdictTone = "worse" | "better" | "flat" | "insufficient";

export interface Verdict {
  tone: VerdictTone;
  /** e.g. "Worse after this deploy", "Not enough traffic to compare yet". */
  headline: string;
  /** Why, in a sentence, with the request counts when traffic is short. */
  detail: string;
}

/**
 * The deploy's verdict from its error rate and p95 moves: worse when either got worse, better when
 * either got better and neither worse, otherwise no change. Fewer than MIN_COMPARE_REQUESTS
 * requests on a side gives no verdict at all.
 */
export function verdict(before: DeploySide, after: DeploySide, open: boolean): Verdict {
  if (before.requests < MIN_COMPARE_REQUESTS || after.requests < MIN_COMPARE_REQUESTS) {
    const counts = `${formatCount(before.requests)} ${plural(before.requests, "request")} before, ${formatCount(after.requests)} after${open ? " so far" : ""}`;
    return {
      tone: "insufficient",
      headline: open ? "Not enough traffic to compare yet" : "Not enough traffic to compare",
      detail: `${counts}. A verdict needs at least ${MIN_COMPARE_REQUESTS} on each side.`,
    };
  }
  const tones = [errorRateDelta(before, after).tone, p95Delta(before, after).tone];
  if (tones.includes("worse")) {
    const what = tones[0] === "worse" && tones[1] === "worse" ? "Error rate and p95 latency" : tones[0] === "worse" ? "Error rate" : "p95 latency";
    return { tone: "worse", headline: "Worse after this deploy", detail: `${what} went up.` };
  }
  if (tones.includes("better")) {
    const what = tones[0] === "better" && tones[1] === "better" ? "Error rate and p95 latency" : tones[0] === "better" ? "Error rate" : "p95 latency";
    return { tone: "better", headline: "Better after this deploy", detail: `${what} went down.` };
  }
  return { tone: "flat", headline: "No notable change", detail: `Error rate moved less than ${ERROR_RATE_STEP_PP} pp and p95 less than ${P95_STEP_RATIO * 100}%.` };
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/** The comparison window in words: `1 h before vs 1 h after`, `1 h before vs the 12 min after so far`. */
export function windowText(windowMinutes: number, afterMinutes: number, open: boolean): string {
  const span = (m: number) => (m % 60 === 0 && m > 0 ? `${m / 60} h` : `${m} min`);
  if (!open) return `${span(windowMinutes)} before vs ${span(windowMinutes)} after`;
  if (afterMinutes <= 0) return `${span(windowMinutes)} before; the after window has just opened`;
  return `${span(windowMinutes)} before vs the ${afterMinutes} min after so far`;
}

/** The endpoints of a comparison, split as the page shows them (each keeps the API's order). */
export function splitEndpoints(es: readonly DeployEndpoint[]): { compared: DeployEndpoint[]; added: DeployEndpoint[]; gone: DeployEndpoint[] } {
  return {
    compared: es.filter((e) => e.change === "compared"),
    added: es.filter((e) => e.change === "new"),
    gone: es.filter((e) => e.change === "gone"),
  };
}

/** A time as the header shows it: `Nov 5, 10:37:20 UTC`. */
export function formatDeployTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

/** A minute of the chart: `10:37 UTC`. */
export function formatMinute(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return `${new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
}

/** How long after the deploy the report arrived, when it is worth saying: `2 min later`; "" within 5 s. */
export function reportLag(deployedAt: string, receivedAt: string): string {
  const s = Math.round((Date.parse(receivedAt) - Date.parse(deployedAt)) / 1000);
  if (!Number.isFinite(s) || s < 5) return "";
  if (s < 120) return `${s} s later`;
  if (s < 2 * 3600) return `${Math.round(s / 60)} min later`;
  return `${Math.round(s / 3600)} h later`;
}

/**
 * How much of the after window has elapsed, for a deploy whose window is still open: whole
 * minutes after the deploy's own minute, at least 0.
 */
export function minutesSoFar(deployedAt: string, now: number): number {
  const t = Date.parse(deployedAt);
  if (Number.isNaN(t)) return 0;
  const minute = Math.floor(t / 60_000) * 60_000;
  return Math.max(0, Math.floor((now - minute) / 60_000) - 1);
}

export const CHANGES_LOAD_FAILED = "We couldn’t load deploys just now.";

/** Where a chart minute sits relative to the deploy: `12 min before`, `Deploy minute`, `5 min after`. */
export function minuteOffsetText(ts: string, deployMinute: string): string {
  const d = Math.round((Date.parse(ts) - Date.parse(deployMinute)) / MINUTE);
  if (!Number.isFinite(d)) return "";
  if (d === 0) return "Deploy minute";
  return d < 0 ? `${-d} min before` : `${d} min after`;
}

/**
 * The p95 line over `n` slots of a `w`×`h` plot (each point at its slot's centre, like the bars
 * under it), broken where a minute had no requests. A lone point is a tiny stroke, so the round
 * cap draws it as a dot. "" when no minute has traffic.
 */
export function p95LinePath(values: readonly number[], present: readonly boolean[], w: number, h: number, max: number): string {
  const n = values.length;
  if (n === 0 || max <= 0) return "";
  const parts: string[] = [];
  let open = false;
  for (let i = 0; i < n; i++) {
    if (!present[i]) {
      open = false;
      continue;
    }
    const x = ((i + 0.5) * w) / n;
    const y = h - 1 - (Math.min(values[i], max) / max) * (h - 2);
    const lone = !present[i + 1] && !open;
    parts.push(`${open ? "L" : "M"}${round2(x)} ${round2(y)}${lone ? " l0.01 0" : ""}`);
    open = true;
  }
  return parts.join(" ");
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** A minute with fewer requests than this has a p95 that is one or two requests: too noisy to set the scale. */
export const SPARSE_MINUTE = 5;

/**
 * The top of the p95 axis: the highest p95 of the minutes with at least SPARSE_MINUTE requests, so
 * one slow request in an almost idle minute does not flatten the line; `offScale` counts the sparse
 * minutes drawn clipped at the top (their exact value is in the tooltip). When every minute is
 * sparse, the plain maximum. 0 when no minute has traffic.
 */
export function p95Scale(points: readonly { requests: number; p95_ms: number }[]): { max: number; offScale: number } {
  const busy = points.filter((p) => p.requests >= SPARSE_MINUTE);
  const pool = busy.length > 0 ? busy : points.filter((p) => p.requests > 0);
  const top = Math.max(0, ...pool.map((p) => p.p95_ms));
  if (top <= 0) return { max: 0, offScale: 0 };
  return { max: top, offScale: points.filter((p) => p.requests > 0 && p.p95_ms > top).length };
}
