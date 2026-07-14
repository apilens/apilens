"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChevronRight, MoreVertical, RefreshCw, Search } from "lucide-react";
import LiveIndicator from "@/components/aperture/LiveIndicator";
import LiveNumber from "@/components/aperture/LiveNumber";
import { useLivePoll } from "@/lib/useLivePoll";
import { fmtNum, fmtCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import { Card } from "@/components/reui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/reui/tabs";
import {
  type RangeValue,
  parseRange,
  resolveRange,
  TimeRangePicker,
} from "../_shared/timeRange";
import FilterBar from "../_shared/filters/FilterBar";
import { parseFilter } from "../_shared/filters/query";
import {
  AXIS_TICK,
  ChartTooltip,
  EmptyBlock,
  GRID,
  formatBucketFull,
  formatBucketTime,
} from "../endpoints/detail/sections";
import ErrorGroupInspector from "./ErrorGroupInspector";
import { type ErrorGroup, reasonPhrase } from "./util";

/* ── Types ───────────────────────────────────────────────────────────── */

interface ErrorSummary {
  total_requests: number;
  client_errors: number;
  server_errors: number;
  error_rate: number;
  unique_issues: number;
  affected_consumers: number;
  last_seen: string | null;
}

interface TSPoint {
  bucket: string;
  client_error_count?: number;
  server_error_count?: number;
  client_error_rate?: number;
  server_error_rate?: number;
}

interface InitialFilters {
  range?: string;
  since?: string;
  until?: string;
  env?: string;
  filter?: string;
}

// Migrate legacy ?env= links into the unified filter string.
function seedFilter(f?: InitialFilters): string {
  if (f?.filter) return f.filter;
  return f?.env ? `env:is:${f.env}` : "";
}

interface Props {
  projectSlug: string;
  initialFilters?: InitialFilters;
}

type MetricKey = "total" | "client" | "server" | "rate";
type SortKey = "occurrences" | "consumers";

const EMPTY_SUMMARY: ErrorSummary = {
  total_requests: 0, client_errors: 0, server_errors: 0, error_rate: 0,
  unique_issues: 0, affected_consumers: 0, last_seen: null,
};

// Error-bar palette — the dusty rose from the reference: client (4xx) a muted
// rose, server (5xx) a deeper red.
const CLIENT_ROSE = "#d99a9a";
const SERVER_ROSE = "#c04b4b";

const groupKey = (g: ErrorGroup) => `${g.status_code}|${g.method}|${g.path}`;

/* ── ReUI badge tone mapping ─────────────────────────────────────────── */

function statusBadgeVariant(status: number) {
  if (status >= 500) return "destructive-light" as const;
  if (status >= 400) return "warning-light" as const;
  if (status >= 300) return "info-light" as const;
  return "success-light" as const;
}

function methodBadgeVariant(method: string) {
  switch (method.toUpperCase()) {
    case "GET": return "info-light" as const;
    case "POST": return "success-light" as const;
    case "PUT":
    case "PATCH": return "warning-light" as const;
    case "DELETE": return "destructive-light" as const;
    default: return "secondary" as const;
  }
}

/* ── Self-measuring chart frame (recharts width(-1) guard) ───────────── */
function Chart({ height, render }: { height: number; render: (w: number) => React.ReactElement }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="relative" style={{ height, width: "100%", minWidth: 0 }}>
      {width > 0 ? render(width) : null}
    </div>
  );
}

/* ── Component ───────────────────────────────────────────────────────── */

export default function ErrorsContent({ projectSlug, initialFilters }: Props) {
  const [rangeValue, setRangeValue] = useState<RangeValue>(() => parseRange(initialFilters));
  const [filter, setFilter] = useState(() => seedFilter(initialFilters));
  // Environment for the group inspector's sub-queries, derived from the filter.
  const filterEnv = useMemo(
    () => parseFilter(filter).find((p) => p.field === "env" && !p.negate)?.values[0] || "",
    [filter],
  );
  const [activeMetric, setActiveMetric] = useState<MetricKey>("total");
  const [refreshKey, setRefreshKey] = useState(0);

  const [summary, setSummary] = useState<ErrorSummary | null>(null);
  const [series, setSeries] = useState<TSPoint[] | null>(null);
  const [groups, setGroups] = useState<ErrorGroup[] | null>(null);
  const [openGroup, setOpenGroup] = useState<ErrorGroup | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("occurrences");
  const [kebab, setKebab] = useState<string | null>(null);

  const resolved = useMemo(() => resolveRange(rangeValue), [rangeValue, refreshKey]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (rangeValue.type === "custom") {
      p.set("since", rangeValue.since);
      p.set("until", rangeValue.until);
    } else {
      p.set("range", rangeValue.id);
    }
    if (filter) p.set("filter", filter);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [rangeValue, filter]);

  const reqId = useRef(0);
  const loadData = useCallback(
    async (silent: boolean) => {
      const { since, until } = resolveRange(rangeValue);
      const qs = () => {
        const p = new URLSearchParams();
        p.set("since", since);
        p.set("until", until);
        if (filter) p.set("filter", filter);
        return p.toString();
      };
      const get = async <T,>(path: string, extra: string, fallback: T): Promise<T> => {
        try {
          const res = await fetch(`/api/projects/${projectSlug}/analytics/${path}?${qs()}${extra}`);
          return res.ok ? ((await res.json()) as T) : fallback;
        } catch {
          return fallback;
        }
      };
      const myId = ++reqId.current;
      if (!silent) setLoading(true);
      const [sum, ts, grp] = await Promise.all([
        get<ErrorSummary>("error-summary", "", EMPTY_SUMMARY),
        get<TSPoint[]>("timeseries", "", []),
        get<ErrorGroup[]>("error-status-groups", "&limit=200", []),
      ]);
      if (myId !== reqId.current) return;
      setSummary(sum);
      setSeries(Array.isArray(ts) ? ts : []);
      setGroups(Array.isArray(grp) ? grp : []);
      if (!silent) setLoading(false);
    },
    [projectSlug, rangeValue, filter],
  );

  useEffect(() => {
    loadData(false);
  }, [loadData, refreshKey]);

  const poll = useLivePoll({
    intervalMs: 5000,
    onTick: () => loadData(true),
    deps: [loadData],
  });

  useEffect(() => {
    if (!kebab) return;
    const onClick = () => setKebab(null);
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [kebab]);

  const cur = summary || EMPTY_SUMMARY;
  const totalErrors = cur.client_errors + cur.server_errors;
  const toneFor = (r: number): "warn" | "bad" | undefined => (r >= 5 ? "bad" : r >= 1 ? "warn" : undefined);

  // Metric tabs — attached to the chart (a click reconfigures the chart below),
  // exactly like the Traffic page.
  const METRICS: Record<MetricKey, { label: string; num: number; fmt: (v: number) => string; tone?: "warn" | "bad" }> = {
    total: { label: "Total errors", num: totalErrors, fmt: fmtNum },
    client: { label: "Client errors", num: cur.client_errors, fmt: fmtNum, tone: cur.client_errors > 0 ? "warn" : undefined },
    server: { label: "Server errors", num: cur.server_errors, fmt: fmtNum, tone: cur.server_errors > 0 ? "bad" : undefined },
    rate: { label: "Error rate", num: cur.error_rate, fmt: (v) => `${v.toFixed(1)} %`, tone: toneFor(cur.error_rate) },
  };
  const metricOrder: MetricKey[] = ["total", "client", "server", "rate"];

  const chartData = useMemo(
    () =>
      (series || []).map((p) => ({
        label: formatBucketTime(p.bucket),
        full: formatBucketFull(p.bucket),
        client: p.client_error_count || 0,
        server: p.server_error_count || 0,
        rate: (p.client_error_rate || 0) + (p.server_error_rate || 0),
      })),
    [series],
  );
  const hasChart = chartData.some((d) => d.client || d.server || d.rate);

  // Client-side search + sort over the loaded status groups.
  const rows = useMemo(() => {
    let list = groups || [];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (g) =>
          g.path.toLowerCase().includes(q) ||
          g.method.toLowerCase().includes(q) ||
          String(g.status_code).includes(q) ||
          reasonPhrase(g.status_code).toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) =>
      sortKey === "consumers" ? b.consumers - a.consumers : b.occurrences - a.occurrences,
    );
  }, [groups, search, sortKey]);

  const maxOcc = Math.max(1, ...rows.map((r) => r.occurrences));

  const copyEndpoint = async (g: ErrorGroup) => {
    try { await navigator.clipboard.writeText(`${g.method} ${g.path}`); } catch { /* ignore */ }
    setKebab(null);
  };

  const pctY = (v: number) => `${v}%`;

  const sortHeadClass = (key: SortKey) =>
    cn(
      "h-auto cursor-pointer px-3.5 py-[11px] text-right text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase select-none",
      sortKey === key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="flex flex-col gap-4">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="m-0 text-lg font-semibold tracking-tight text-foreground">Errors</h1>

        <div className="tf-filter-grow">
          <FilterBar projectSlug={projectSlug} value={filter} onChange={setFilter} />
        </div>

        <TimeRangePicker value={rangeValue} resolved={resolved} onChange={setRangeValue} />
        <LiveIndicator live={poll.live} onToggle={poll.toggle} lastTickAt={poll.lastTickAt} />

        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Refresh now"
          aria-label="Refresh now"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {/* ── Metrics + chart (tabs attached to the visualization) ── */}
      <Card className="gap-0 overflow-hidden rounded-[10px] py-0 shadow-none">
        <Tabs
          value={activeMetric}
          onValueChange={(v) => setActiveMetric(v as MetricKey)}
          className="w-full gap-0"
        >
          <TabsList
            variant="line"
            aria-label="Error metric"
            className="grid w-full grid-cols-4 gap-0 rounded-none border-b border-border bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-auto"
          >
            {metricOrder.map((key) => {
              const m = METRICS[key];
              return (
                <TabsTrigger
                  key={key}
                  value={key}
                  className={cn(
                    "group/mt relative h-auto min-w-0 flex-col items-start justify-start gap-2 overflow-hidden rounded-none border-0 border-l border-border px-3.5 py-3.5 first:border-l-0",
                    "group-data-[variant=line]/tabs-list:hover:bg-accent",
                    "group-data-[variant=line]/tabs-list:data-[state=active]:bg-muted dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-muted",
                    "dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-border",
                  )}
                >
                  <span className="max-w-full truncate text-[11px] tracking-[0.04em] uppercase text-muted-foreground group-data-[state=active]/mt:text-primary">
                    {m.label}
                  </span>
                  <span
                    className={cn(
                      "max-w-full truncate text-2xl font-semibold tracking-tight tabular-nums",
                      m.tone === "bad" ? "text-destructive" : m.tone === "warn" ? "text-warning" : "text-foreground",
                    )}
                  >
                    {loading ? "—" : <LiveNumber value={m.num} format={m.fmt} />}
                  </span>
                  {/* Active indicator: teal bar bridging into the chart below. */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary opacity-0 transition-opacity group-data-[state=active]/mt:opacity-100"
                  />
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        <div className="p-4">
          {activeMetric === "total" && !loading && hasChart ? (
            <div className="mb-1.5 flex justify-end gap-3.5">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block size-[9px] rounded-[2px]" style={{ background: SERVER_ROSE }} />
                Server (5xx)
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block size-[9px] rounded-[2px]" style={{ background: CLIENT_ROSE }} />
                Client (4xx)
              </span>
            </div>
          ) : null}
          {series === null || loading ? (
            <Skeleton className="h-[220px] w-full" />
          ) : !hasChart ? (
            <EmptyBlock message="No errors in the selected period." />
          ) : (
            <Chart
              height={220}
              render={(w) =>
                activeMetric === "rate" ? (
                  <AreaChart key="rate" width={w} height={220} data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                    <defs>
                      <linearGradient id="errRateFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={SERVER_ROSE} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={SERVER_ROSE} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={28} tickLine={false} axisLine={{ stroke: GRID }} />
                    <YAxis tick={AXIS_TICK} tickFormatter={pctY} width={44} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTooltip valueFormatter={(v: number) => `${v.toFixed(1)} %`} />} cursor={{ stroke: SERVER_ROSE, strokeDasharray: "3 3" }} />
                    <Area type="monotone" dataKey="rate" name="Error rate" stroke={SERVER_ROSE} fill="url(#errRateFill)" strokeWidth={2} />
                  </AreaChart>
                ) : (
                  <BarChart key={activeMetric} width={w} height={220} data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="22%">
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={28} tickLine={false} axisLine={{ stroke: GRID }} />
                    <YAxis tick={AXIS_TICK} allowDecimals={false} tickFormatter={fmtCompact} tickLine={false} axisLine={false} width={40} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(192,75,75,0.10)" }} />
                    {(activeMetric === "total" || activeMetric === "server") && (
                      <Bar dataKey="server" name="Server (5xx)" stackId="e" fill={SERVER_ROSE} maxBarSize={34} radius={activeMetric === "server" ? [3, 3, 0, 0] : undefined} />
                    )}
                    {(activeMetric === "total" || activeMetric === "client") && (
                      <Bar dataKey="client" name="Client (4xx)" stackId="e" fill={CLIENT_ROSE} maxBarSize={34} radius={[3, 3, 0, 0]} />
                    )}
                  </BarChart>
                )
              }
            />
          )}
        </div>
      </Card>

      {/* ── Errors table ── */}
      <Card className="gap-0 overflow-hidden rounded-[10px] py-0 shadow-none">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search size={15} className="shrink-0 text-muted-foreground" />
          <Input
            className="h-auto rounded-none border-0 bg-transparent p-0 text-[13.5px] shadow-none focus-visible:ring-0 dark:bg-transparent"
            placeholder="Search errors"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {groups === null ? (
          <div className="p-4">
            <Skeleton className="h-80 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyBlock message={search ? "No errors match your search." : "No errors in this period. 🎉"} />
        ) : (
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead aria-hidden className="h-auto w-[30px] px-3.5 py-[11px]" />
                <TableHead className="h-auto px-3.5 py-[11px] text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase text-muted-foreground">
                  Response status
                </TableHead>
                <TableHead className="h-auto px-3.5 py-[11px] text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase text-muted-foreground">
                  Endpoint
                </TableHead>
                <TableHead
                  className={sortHeadClass("occurrences")}
                  onClick={() => setSortKey("occurrences")}
                  aria-sort={sortKey === "occurrences" ? "descending" : "none"}
                >
                  Occurrences{sortKey === "occurrences" ? " ▾" : ""}
                </TableHead>
                <TableHead
                  className={sortHeadClass("consumers")}
                  onClick={() => setSortKey("consumers")}
                  aria-sort={sortKey === "consumers" ? "descending" : "none"}
                >
                  Consumers{sortKey === "consumers" ? " ▾" : ""}
                </TableHead>
                <TableHead aria-hidden className="h-auto w-11 px-3.5 py-[11px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => (
                <TableRow key={groupKey(g)} className="cursor-pointer" onClick={() => setOpenGroup(g)}>
                  <TableCell className="w-[30px] px-3.5 py-[11px] text-muted-foreground">
                    <ChevronRight size={15} />
                  </TableCell>
                  <TableCell className="px-3.5 py-[11px]">
                    <span className="inline-flex items-center gap-2">
                      <Badge variant={statusBadgeVariant(g.status_code)} className="tabular-nums">
                        {g.status_code}
                      </Badge>
                      <span className="text-[13px] text-foreground">{reasonPhrase(g.status_code)}</span>
                    </span>
                  </TableCell>
                  <TableCell className="max-w-0 px-3.5 py-[11px]">
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge variant={methodBadgeVariant(g.method)} className="font-mono">
                        {g.method}
                      </Badge>
                      <span className="truncate font-mono text-xs text-muted-foreground">{g.path}</span>
                    </span>
                  </TableCell>
                  <TableCell className="px-3.5 py-[11px] text-right tabular-nums">
                    <span className="relative inline-flex min-w-24 items-center justify-end overflow-hidden rounded-[5px] px-2 py-1">
                      <span
                        aria-hidden
                        className="absolute inset-y-0 left-0 rounded-[5px] bg-primary/15"
                        style={{ width: `${(g.occurrences / maxOcc) * 100}%` }}
                      />
                      <span className="relative text-[13px] font-semibold tabular-nums text-foreground">
                        {fmtNum(g.occurrences)}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="w-[110px] px-3.5 py-[11px] text-right text-[13px] tabular-nums text-muted-foreground">
                    {fmtNum(g.consumers)}
                  </TableCell>
                  <TableCell className="w-11 px-1 py-[11px] text-center">
                    <DropdownMenu
                      open={kebab === groupKey(g)}
                      onOpenChange={(open) => setKebab(open ? groupKey(g) : null)}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-foreground"
                          aria-label="Row actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical size={15} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem onSelect={() => { setOpenGroup(g); setKebab(null); }}>
                          View details
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => copyEndpoint(g)}>
                          Copy endpoint
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {openGroup ? (
        <ErrorGroupInspector
          projectSlug={projectSlug}
          group={openGroup}
          since={resolved.since}
          until={resolved.until}
          environment={filterEnv}
          onClose={() => setOpenGroup(null)}
        />
      ) : null}
    </div>
  );
}
