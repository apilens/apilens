"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CONSUMER_RANGES, type ConsumersQuery, consumersHref } from "@/lib/consumers";
import { type ExploreQuery, type ExploreRange, rangeMs } from "@/lib/explore-query";
import type { QueryRange } from "@/lib/identity";
import { type RangePick, TimeRangeFacet, TimeRangePill } from "../explore/time-range";

/** The page's range as Explore's query, for Explore's time range controls. */
const asExplore = (q: ConsumersQuery): ExploreQuery => ({ range: q.range as ExploreRange, from: q.from || undefined, to: q.to || undefined, conds: [] });

/**
 * Applies a pick from Explore's date picker, as Traffic does: the four presets are ranges (the
 * window cleared); any other pick (a typed duration, 10 minutes, days on the calendar) becomes a
 * window ending at its end, or now. Picking a window keeps the filters and closes the drawer.
 */
function useConsumersRange(project: string, q: ConsumersQuery): (r: RangePick) => void {
  const router = useRouter();
  return (r) => {
    if (!r.from && (CONSUMER_RANGES as readonly string[]).includes(r.range)) {
      return router.push(consumersHref(project, { ...q, range: r.range as QueryRange, from: "", to: "", consumer: null }), { scroll: false });
    }
    const end = r.to ? Date.parse(r.to) : Date.now();
    const start = r.from ? Date.parse(r.from) : end - rangeMs(r.range);
    const iso = (t: number) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace(".000Z", "Z");
    router.push(consumersHref(project, { ...q, from: iso(start), to: iso(end), consumer: null }), { scroll: false });
  };
}

/** The sidebar's Time Range, Explore's own (one bordered button that opens the date picker). */
export function ConsumersTimeRange({ project, query: q }: { project: string; query: ConsumersQuery }) {
  const onRange = useConsumersRange(project, q);
  const [open, setOpen] = useState(true);
  return <TimeRangeFacet query={asExplore(q)} onRange={onRange} open={open} onToggle={() => setOpen((o) => !o)} />;
}

/**
 * The filter bar's Time range pill, Explore's and Traffic's (TimeRangePill): absent at the default
 * 24 hours, otherwise `Time range = Last 7 days` (or the window), opening the same date picker;
 * × goes back to the last 24 hours.
 */
export function ConsumersTimePill({ project, query: q }: { project: string; query: ConsumersQuery }) {
  const onRange = useConsumersRange(project, q);
  return <TimeRangePill query={asExplore(q)} onRange={onRange} />;
}
