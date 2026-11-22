"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { type ExploreRange, rangeMs } from "@/lib/explore-query";
import { TRAFFIC_RANGES, type TrafficState, trafficHref } from "@/lib/traffic";
import { type RangePick, TimeRangeFacet } from "../explore/time-range";

/**
 * The sidebar's Time Range, Explore's own (TimeRangeFacet: one bordered button that opens the
 * date picker). Traffic reads its four presets as ranges; any other pick (a typed duration, 10
 * minutes, a window on the calendar) becomes a window ending at its end, or now.
 */
export function TrafficTimeRange({ project, query: q }: { project: string; query: TrafficState }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const onRange = (r: RangePick) => {
    if (!r.from && (TRAFFIC_RANGES as readonly string[]).includes(r.range)) {
      return router.push(trafficHref(project, { ...q, range: r.range as TrafficState["range"], from: "", to: "" }));
    }
    const end = r.to ? Date.parse(r.to) : Date.now();
    const start = r.from ? Date.parse(r.from) : end - rangeMs(r.range);
    const iso = (t: number) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace(".000Z", "Z");
    router.push(trafficHref(project, { ...q, from: iso(start), to: iso(end) }));
  };
  return <TimeRangeFacet query={{ range: q.range as ExploreRange, from: q.from || undefined, to: q.to || undefined, conds: [] }} onRange={onRange} open={open} onToggle={() => setOpen((o) => !o)} />;
}

