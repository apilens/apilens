"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Fingerprint, RefreshCw, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import { Card } from "@/components/reui/card";
import { Input } from "@/components/reui/input";
import { Skeleton } from "@/components/reui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/reui/table";
import {
  formatMs,
  formatNumber,
  timeAgo,
} from "../endpoints/detail/sections";
import {
  type RangeValue,
  DEFAULT_RANGE,
  ROLLING_PRESETS,
  parseRange,
  resolveRange,
  TimeRangePicker,
} from "../_shared/timeRange";
import FilterBar from "../_shared/filters/FilterBar";
import { parseFilter, serializeFilter } from "../_shared/filters/query";

interface ConsumersContentProps {
  projectSlug: string;
}

interface ConsumerStat {
  consumer: string;
  consumer_identifier: string;
  consumer_group: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  client_error_rate?: number;
  server_error_rate?: number;
  client_error_count?: number;
  server_error_count?: number;
  avg_response_time_ms: number;
  last_seen_at: string | null;
}

export default function ConsumersContent({ projectSlug }: ConsumersContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [rangeValue, setRangeValue] = useState<RangeValue>(DEFAULT_RANGE);
  // Unified rich filter (app, env, method, status, path, latency…). The
  // per-consumer `consumer` field is excluded — this page IS the consumer list.
  const [filter, setFilter] = useState("");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [rows, setRows] = useState<ConsumerStat[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isInitialized, setIsInitialized] = useState(false);

  // Seed range / filter / search from the URL once (shareable links).
  useEffect(() => {
    if (isInitialized) return;
    setRangeValue(parseRange({
      range: searchParams.get("range") || undefined,
      since: searchParams.get("since") || undefined,
      until: searchParams.get("until") || undefined,
    }));
    const f = searchParams.get("filter");
    if (f) setFilter(f);
    const s = searchParams.get("q");
    if (s) setSearch(s);
    setIsInitialized(true);
  }, [searchParams, isInitialized]);

  // Mirror the active view into the URL so it fully describes the page.
  useEffect(() => {
    if (!isInitialized) return;
    const p = new URLSearchParams();
    if (rangeValue.type === "custom") {
      p.set("since", rangeValue.since);
      p.set("until", rangeValue.until);
    } else {
      p.set("range", rangeValue.id);
    }
    if (filter) p.set("filter", filter);
    if (search.trim()) p.set("q", search.trim());
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [isInitialized, rangeValue, filter, search]);

  // Debounce the search box so we don't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Re-resolve when the range changes or on refresh, so rolling windows slide.
  const resolved = useMemo(() => resolveRange(rangeValue), [rangeValue, refreshKey]);
  const { since, until } = resolved;

  // Consumer stats.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const p = new URLSearchParams();
      p.set("since", since);
      p.set("until", until);
      if (filter) p.set("filter", filter);
      if (debouncedSearch) p.set("search", debouncedSearch);
      p.set("limit", "500");
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/consumer-stats?${p.toString()}`);
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectSlug, since, until, filter, debouncedSearch, refreshKey]);

  const maxRequests = useMemo(
    () => Math.max(1, ...(rows || []).map((r) => r.total_requests)),
    [rows],
  );

  // Drill into a consumer's requests in Request logs, with the current
  // app/env/time filters carried across.
  const openConsumer = (c: ConsumerStat) => {
    const p = new URLSearchParams();
    // Carry the active rich filter across, plus this consumer (stable id).
    const preds = parseFilter(filter).filter((x) => x.field !== "consumer");
    preds.push({ field: "consumer", op: "is", values: [c.consumer_identifier || c.consumer] });
    p.set("filter", serializeFilter(preds));
    // Carry the range when it maps to a Request-logs preset window.
    if (rangeValue.type === "preset") {
      const hours = ROLLING_PRESETS.find((r) => r.id === rangeValue.id)?.hours;
      if (hours && hours !== 24 && [1, 6, 168, 720].includes(hours)) p.set("range", String(hours));
    }
    router.push(`/projects/${projectSlug}/endpoints?${p.toString()}`);
  };

  return (
    <div className="ep-rl">
      {/* ── Toolbar: filter search + consumer search + time on one line ── */}
      <div className="ep-rl-toolbar">
        <div className="ep-rl-filtergrow">
          <FilterBar projectSlug={projectSlug} value={filter} onChange={setFilter} exclude={["consumer"]} />
        </div>

        <div className="relative w-full max-w-[260px]">
          <Search size={12} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search consumer…"
            className="h-[30px] rounded-full pl-8 pr-8 text-xs"
          />
          {search && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full text-muted-foreground"
              onClick={() => setSearch("")}
              aria-label="Clear"
            >
              <X size={12} />
            </Button>
          )}
        </div>

        <TimeRangePicker value={rangeValue} resolved={resolved} onChange={setRangeValue} />

        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="size-[30px] shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {/* ── Consumer table ── */}
      <Card className="gap-0 overflow-hidden rounded-xl py-0">
        {loading && (rows === null || rows.length === 0) ? (
          <div className="flex flex-col gap-2 p-4" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-1.5">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="ml-auto h-3.5 w-24" />
                <Skeleton className="h-3.5 w-16" />
              </div>
            ))}
          </div>
        ) : rows && rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
            {debouncedSearch
              ? "No consumers match this search in the selected period."
              : "No identified consumers in the selected period. Set a consumer in your SDK middleware to see them here."}
          </div>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8 px-3" aria-hidden />
                <TableHead className="h-9 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Consumer</TableHead>
                <TableHead className="h-9 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Group</TableHead>
                <TableHead className="h-9 px-3 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Requests</TableHead>
                <TableHead className="h-9 px-3 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Client 4xx</TableHead>
                <TableHead className="h-9 px-3 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Server 5xx</TableHead>
                <TableHead className="h-9 px-3 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Avg response</TableHead>
                <TableHead className="h-9 px-3 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Last seen</TableHead>
                <TableHead className="w-8 px-3" aria-hidden />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rows || []).map((c) => (
                <TableRow
                  key={c.consumer}
                  className="group cursor-pointer"
                  onClick={() => openConsumer(c)}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openConsumer(c); }
                  }}
                >
                  <TableCell className="w-8 px-3 py-2.5 text-muted-foreground"><Fingerprint size={14} /></TableCell>
                  <TableCell className="px-3 py-2.5">
                    <div className="flex flex-col gap-px">
                      <span className="font-medium text-foreground">{c.consumer}</span>
                      {c.consumer_identifier && c.consumer_identifier !== c.consumer ? (
                        <span className="font-mono text-[11px] text-muted-foreground">{c.consumer_identifier}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-2.5">
                    {c.consumer_group ? (
                      <Badge variant="outline" radius="full" className="text-muted-foreground">{c.consumer_group}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    <span className="relative inline-flex h-[18px] min-w-[110px] items-center justify-end">
                      <span
                        className="absolute left-0 top-1/2 h-3.5 min-w-0.5 -translate-y-1/2 rounded-[3px] bg-primary/20"
                        style={{ width: `${(c.total_requests / maxRequests) * 100}%` }}
                      />
                      <span className="relative z-[1] pr-0.5 text-foreground">{formatNumber(c.total_requests)}</span>
                    </span>
                  </TableCell>
                  <TableCell className={cn("px-3 py-2.5 text-right tabular-nums text-muted-foreground", (c.client_error_rate || 0) > 0 && "text-warning")}>
                    {(c.client_error_rate || 0).toFixed(1)} %
                  </TableCell>
                  <TableCell className={cn("px-3 py-2.5 text-right tabular-nums text-muted-foreground", (c.server_error_rate || 0) > 0 && "text-destructive")}>
                    {(c.server_error_rate || 0).toFixed(1)} %
                  </TableCell>
                  <TableCell className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{formatMs(c.avg_response_time_ms)}</TableCell>
                  <TableCell className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{c.last_seen_at ? timeAgo(c.last_seen_at) : "—"}</TableCell>
                  <TableCell className="w-8 px-3 py-2.5 text-right text-muted-foreground opacity-50 transition-opacity group-hover:opacity-100">
                    <ChevronRight size={15} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
