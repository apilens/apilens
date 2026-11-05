// The Changes view (#597): every deploy of the project with its error rate and p95 in the hour
// before and the hour after, and whether that moved enough to call out. Pure helpers, so the
// thresholds and the copy are unit-tested (changes.test.ts).
import type { DeployChange, DeploySide, QueryRange } from "./identity";

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

/** Explore, filtered to the deploy's release and environment. */
export function exploreHref(project: string, d: Pick<DeployChange, "release" | "environment">): string {
  const q = new URLSearchParams({ release: d.release });
  if (d.environment) q.set("env", d.environment);
  return `/${encodeURIComponent(project)}/explore?${q.toString()}`;
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
