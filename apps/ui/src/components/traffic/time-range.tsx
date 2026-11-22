"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { type ExploreQuery, type ExploreRange, rangeMs } from "@/lib/explore-query";
import { TRAFFIC_RANGES, type TrafficState, trafficHref } from "@/lib/traffic";
import { type RangePick, TimeRangeFacet, TimeRangePill } from "../explore/time-range";

/** Traffic's range as Explore's query, for Explore's time range controls. */
const asExplore = (q: TrafficState): ExploreQuery => ({ range: q.range as ExploreRange, from: q.from || undefined, to: q.to || undefined, conds: [] });

/**
 * Applies a pick from Explore's date picker to Traffic. Traffic reads its four presets as ranges;
 * any other pick (a typed duration, 10 minutes, a window on the calendar) becomes a window ending
 * at its end, or now.
 */
function useTrafficRange(project: string, q: TrafficState): (r: RangePick) => void {
  const router = useRouter();
  return (r) => {
    if (!r.from && (TRAFFIC_RANGES as readonly string[]).includes(r.range)) {
      return router.push(trafficHref(project, { ...q, range: r.range as TrafficState["range"], from: "", to: "" }));
    }
    const end = r.to ? Date.parse(r.to) : Date.now();
    const start = r.from ? Date.parse(r.from) : end - rangeMs(r.range);
    const iso = (t: number) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace(".000Z", "Z");
    router.push(trafficHref(project, { ...q, from: iso(start), to: iso(end) }));
  };
}

/** The sidebar's Time Range, Explore's own (TimeRangeFacet: one bordered button that opens the date picker). */
export function TrafficTimeRange({ project, query: q }: { project: string; query: TrafficState }) {
  const onRange = useTrafficRange(project, q);
  const [open, setOpen] = useState(true);
  return <TimeRangeFacet query={asExplore(q)} onRange={onRange} open={open} onToggle={() => setOpen((o) => !o)} />;
}

/**
 * The filter bar's Time range pill, Explore's (TimeRangePill): absent at the default 24 hours,
 * otherwise `Time range = Last 7 days` (or the window), opening the same date picker; × resets.
 */
export function TrafficTimePill({ project, query: q }: { project: string; query: TrafficState }) {
  const onRange = useTrafficRange(project, q);
  return <TimeRangePill query={asExplore(q)} onRange={onRange} />;
}
