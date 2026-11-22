"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CONSUMER_RANGES, type ConsumersQuery, consumersHref } from "@/lib/consumers";
import { type ExploreRange, rangeMs } from "@/lib/explore-query";
import type { QueryRange } from "@/lib/identity";
import { type RangePick, TimeRangeFacet } from "../explore/time-range";

/**
 * The sidebar's Time Range, Explore's own (TimeRangeFacet). The consumers reads take the four
 * ranges only, so a preset is read as is and any other pick (a typed duration, a calendar window)
 * as the smallest range that covers its length.
 */
export function ConsumersTimeRange({ project, query: q }: { project: string; query: ConsumersQuery }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const onRange = (r: RangePick) => {
    const span = r.from ? (r.to ? Date.parse(r.to) : Date.now()) - Date.parse(r.from) : rangeMs(r.range);
    const range = CONSUMER_RANGES.find((x) => rangeMs(x) >= span) ?? CONSUMER_RANGES[CONSUMER_RANGES.length - 1];
    router.push(consumersHref(project, { ...q, range: range as QueryRange, consumer: null }), { scroll: false });
  };
  return <TimeRangeFacet query={{ range: q.range as ExploreRange, conds: [] }} onRange={onRange} open={open} onToggle={() => setOpen((o) => !o)} />;
}
