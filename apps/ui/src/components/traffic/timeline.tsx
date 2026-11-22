"use client";

import { useRouter } from "next/navigation";
import type { RequestTimeline, TrafficPoint } from "@/lib/identity";
import { StatusChart } from "../explore/status-chart";

const ALL = new Set(["2xx", "4xx", "5xx"] as const);

/** Traffic's points as Explore's timeline: each bucket split into 2xx–3xx, 4xx and 5xx. */
export function asTimeline(points: readonly TrafficPoint[]): RequestTimeline {
  const at = points.map((p) => Date.parse(p.ts));
  const step = at.length > 1 ? at[1] - at[0] : 3_600_000;
  return {
    from: points[0]?.ts ?? "",
    to: at.length ? new Date(at[at.length - 1] + step).toISOString() : "",
    bucket_seconds: Math.round(step / 1000),
    buckets: points.map((p) => ({
      ts: p.ts,
      requests: p.requests,
      successful: Math.max(0, p.requests - p.client_errors - p.server_errors),
      client_errors: p.client_errors,
      server_errors: p.server_errors,
    })),
  };
}

/**
 * Explore's bar chart (StatusChart: 60px, full width, stacked by status class) over Traffic's
 * requests. Dragging across bars offers that window; picking it narrows this page (`page`, a link
 * template with `__FROM__` and `__TO__`).
 */
export function TrafficTimeline({ points, page }: { points: readonly TrafficPoint[]; page: string }) {
  const router = useRouter();
  // No buckets (nothing reported in the window yet): an empty plot of the chart's size, so the
  // rows under it don't move and the chart never reads a window without ends.
  if (points.length === 0) return <section className="exc" aria-label="No requests over time" />;
  const onRange = (from: string, to: string) => router.push(page.replace("__FROM__", encodeURIComponent(from)).replace("__TO__", encodeURIComponent(to)));
  return <StatusChart timeline={asTimeline(points)} shown={ALL} onRange={onRange} />;
}
