/**
 * The "vs previous" line under a summary tile (#1000): how the range compares with the window of
 * the same length just before it, which the summary, latency and error-status reads return as
 * `previous`. Without a previous window (no requests in it) there is no comparison and the tile
 * shows none.
 */

/** Which way of moving is good for the number: up (Apdex), down (errors, latency) or neither (requests). */
export type Better = "up" | "down" | "neither";

/** good / bad colour the line by `Better`; flat is no change, neutral a change that is neither. */
export type Tone = "good" | "bad" | "neutral" | "flat";

export interface Comparison {
  /** The whole line, for example `▲ 12.4 pts vs previous 24h`. */
  text: string;
  tone: Tone;
}

/** How the change of a number is written: rate in percentage points, relative in percent, score as a difference. */
export type Kind = "rate" | "relative" | "score";

const ARROW_UP = "▲";
const ARROW_DOWN = "▼";

/**
 * The comparison of `current` with `previous` over `range` (`1h`, `24h`, ...), or null when there
 * is no previous value to compare with (or, for a relative change, it was zero).
 */
export function compare(
  current: number | null | undefined,
  previous: number | null | undefined,
  { kind, better, range }: { kind: Kind; better: Better; range: string },
): Comparison | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const vs = `vs previous ${range}`;
  let change: number;
  let amount: string;
  switch (kind) {
    case "rate":
      change = Math.round((current - previous) * 1000) / 10;
      amount = `${Math.abs(change).toFixed(1)} pts`;
      break;
    case "score":
      change = Math.round((current - previous) * 100) / 100;
      amount = Math.abs(change).toFixed(2);
      break;
    case "relative":
      if (previous <= 0) return null;
      change = Math.round(((current - previous) / previous) * 1000) / 10;
      amount = `${Math.abs(change).toFixed(1)}%`;
      break;
  }
  if (change === 0) return { text: `No change ${vs}`, tone: "flat" };
  const up = change > 0;
  const tone: Tone = better === "neither" ? "neutral" : up === (better === "up") ? "good" : "bad";
  return { text: `${up ? ARROW_UP : ARROW_DOWN} ${amount} ${vs}`, tone };
}
