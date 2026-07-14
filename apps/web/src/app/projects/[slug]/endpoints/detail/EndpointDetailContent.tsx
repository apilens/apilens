"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, Link2, Lock } from "lucide-react";
import { StatStrip, type Stat } from "@/components/aperture";
import { cn } from "@/lib/utils";
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/reui/tabs";
import FilterBar from "../../_shared/filters/FilterBar";
import {
  ConsumersSection,
  DataTransferredSection,
  EMPTY_DETAIL,
  EMPTY_HISTOGRAMS,
  EmptyBlock,
  LatencyHistogramBlock,
  LatencySection,
  MethodBadge,
  RequestsTab,
  StatusCodesBlock,
  TrafficSection,
  formatMs,
  formatNumber,
  type ConsumerRow,
  type EndpointDetail,
  type Histograms,
  type RequestRow,
  type StatusCodeRow,
  type TimeseriesPoint,
} from "./sections";

/* ── Types ───────────────────────────────────────────────────────────── */

type TabKey = "overview" | "requests";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "requests", label: "Requests" },
];

const TIME_RANGES: Array<{ label: string; value: number }> = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
];

/* ── Page component ──────────────────────────────────────────────────── */

export default function EndpointDetailContent({ projectSlug }: { projectSlug: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Endpoint identity (carried in the URL so the page is shareable).
  const method = searchParams.get("method") || "";
  const path = searchParams.get("path") || "";

  const [appSlugs] = useState<string[]>(() => {
    const raw = searchParams.get("apps");
    return raw ? raw.split(",").filter(Boolean) : [];
  });

  // Filters — initialised from URL, written back on change.
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    searchParams.get("tab") === "requests" ? "requests" : "overview",
  );
  const [selectedRange, setSelectedRange] = useState<number>(() => {
    const r = Number(searchParams.get("range"));
    return r && !Number.isNaN(r) ? r : 24;
  });
  // Rich filter (env, status, consumer, latency, size, ip, ua …) — method,
  // path and app are the fixed scope and are excluded from the picker, so this
  // only ever narrows within the endpoint the user is already on. Seeds from
  // ?filter=, migrating a legacy ?env= link into a canonical predicate.
  const [filter, setFilter] = useState<string>(() => {
    const existing = searchParams.get("filter");
    if (existing) return existing;
    const env = searchParams.get("env");
    return env ? `env:is:${env}` : "";
  });

  // Custom range.
  const [customActive, setCustomActive] = useState<boolean>(() => !!searchParams.get("custom_since"));
  const [customSince, setCustomSince] = useState<string>(() => searchParams.get("custom_since") || "");
  const [customUntil, setCustomUntil] = useState<string>(() => searchParams.get("custom_until") || "");
  const [customPanelOpen, setCustomPanelOpen] = useState(false);
  const [customSinceDraft, setCustomSinceDraft] = useState<string>(() => searchParams.get("custom_since") || "");
  const [customUntilDraft, setCustomUntilDraft] = useState<string>(() => searchParams.get("custom_until") || "");
  const [customRangeError, setCustomRangeError] = useState("");
  const customPopoverRef = useRef<HTMLDivElement | null>(null);

  const [copied, setCopied] = useState(false);

  const timeParams = useMemo(() => {
    if (customActive && customSince) {
      return { since: customSince, until: customUntil || undefined };
    }
    const since = new Date(Date.now() - selectedRange * 60 * 60 * 1000).toISOString();
    return { since, until: undefined as string | undefined };
  }, [customActive, customSince, customUntil, selectedRange]);

  // Keep the URL in sync so the current view is always shareable.
  useEffect(() => {
    if (!method || !path) return;
    const params = new URLSearchParams();
    params.set("method", method);
    params.set("path", path);
    if (customActive && customSince) {
      params.set("custom_since", customSince);
      if (customUntil) params.set("custom_until", customUntil);
    } else if (selectedRange !== 24) {
      params.set("range", String(selectedRange));
    }
    if (filter) params.set("filter", filter);
    if (appSlugs.length) params.set("apps", appSlugs.join(","));
    if (activeTab !== "overview") params.set("tab", activeTab);
    router.replace(`/projects/${projectSlug}/endpoints/detail?${params.toString()}`, { scroll: false });
  }, [method, path, selectedRange, filter, appSlugs, activeTab, customActive, customSince, customUntil, projectSlug, router]);

  // Close the custom-range popover on outside click.
  useEffect(() => {
    if (!customPanelOpen) return undefined;
    const onClick = (e: MouseEvent) => {
      if (customPopoverRef.current && !customPopoverRef.current.contains(e.target as Node)) {
        setCustomPanelOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [customPanelOpen]);

  /* ── Data fetching ── */

  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[] | null>(null);
  const [consumers, setConsumers] = useState<ConsumerRow[] | null>(null);
  const [statusCodes, setStatusCodes] = useState<StatusCodeRow[] | null>(null);
  const [recentRequests, setRecentRequests] = useState<RequestRow[] | null>(null);
  const [histograms, setHistograms] = useState<Histograms | null>(null);

  const loadingRef = useRef<Set<string>>(new Set());
  const reqIdRef = useRef(0);
  const [, forceRender] = useState(0);

  const baseParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("method", method);
    params.set("path", path);
    if (appSlugs.length) params.set("app_slugs", appSlugs.join(","));
    params.set("since", timeParams.since);
    if (timeParams.until) params.set("until", timeParams.until);
    if (filter) params.set("filter", filter);
    return params;
  }, [method, path, appSlugs, timeParams, filter]);

  useEffect(() => {
    reqIdRef.current += 1;
    setDetail(null);
    setTimeseries(null);
    setConsumers(null);
    setStatusCodes(null);
    setRecentRequests(null);
    setHistograms(null);
    loadingRef.current = new Set();
  }, [baseParams]);

  const fetchResource = useCallback(
    async <T,>(key: string, endpointPath: string, setter: (val: T) => void, emptyValue: T, extra?: Record<string, string>) => {
      if (loadingRef.current.has(key)) return;
      loadingRef.current.add(key);
      const reqId = reqIdRef.current;
      forceRender((n) => n + 1);
      try {
        const params = new URLSearchParams(baseParams);
        if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
        const res = await fetch(`/api/projects/${projectSlug}/analytics/${endpointPath}?${params.toString()}`);
        if (reqId !== reqIdRef.current) return;
        setter(res.ok ? ((await res.json()) as T) : emptyValue);
      } catch {
        if (reqId === reqIdRef.current) setter(emptyValue);
      } finally {
        loadingRef.current.delete(key);
        forceRender((n) => n + 1);
      }
    },
    [baseParams, projectSlug],
  );

  useEffect(() => {
    if (!method || !path) return;
    if (detail === null) fetchResource<EndpointDetail>("detail", "endpoint-detail", setDetail, EMPTY_DETAIL);
    if (activeTab === "overview") {
      if (timeseries === null) fetchResource<TimeseriesPoint[]>("timeseries", "endpoint-timeseries", setTimeseries, []);
      if (consumers === null) fetchResource<ConsumerRow[]>("consumers", "endpoint-consumers", setConsumers, [], { limit: "8" });
      if (statusCodes === null) fetchResource<StatusCodeRow[]>("status-codes", "endpoint-status-codes", setStatusCodes, []);
      if (histograms === null) fetchResource<Histograms>("histograms", "endpoint-histograms", setHistograms, EMPTY_HISTOGRAMS);
    } else if (activeTab === "requests") {
      if (recentRequests === null) fetchResource<RequestRow[]>("requests", "endpoint-requests", setRecentRequests, [], { limit: "50" });
    }
  }, [method, path, activeTab, detail, timeseries, consumers, statusCodes, recentRequests, histograms, fetchResource]);

  /* ── Filter handlers ── */

  const pickPreset = (hours: number) => {
    setSelectedRange(hours);
    setCustomActive(false);
    setCustomPanelOpen(false);
    setCustomRangeError("");
  };

  const updateDraftPart = (field: "since" | "until", part: "date" | "time", value: string) => {
    const setter = field === "since" ? setCustomSinceDraft : setCustomUntilDraft;
    const current = field === "since" ? customSinceDraft : customUntilDraft;
    if (part === "date") {
      const timeVal = current ? current.slice(11, 16) : "00:00";
      setter(value ? `${value}T${timeVal}:00.000Z` : "");
    } else {
      const dateVal = current ? current.slice(0, 10) : new Date().toISOString().slice(0, 10);
      setter(value ? `${dateVal}T${value}:00.000Z` : "");
    }
  };

  const applyCustomRange = () => {
    if (!customSinceDraft) {
      setCustomRangeError("Start date and time required");
      return;
    }
    const sinceDate = new Date(customSinceDraft);
    const untilDate = customUntilDraft ? new Date(customUntilDraft) : null;
    if (Number.isNaN(sinceDate.getTime())) {
      setCustomRangeError("Invalid start date/time");
      return;
    }
    if (untilDate && Number.isNaN(untilDate.getTime())) {
      setCustomRangeError("Invalid end date/time");
      return;
    }
    if (untilDate && sinceDate >= untilDate) {
      setCustomRangeError("Start must be before end");
      return;
    }
    setCustomSince(sinceDate.toISOString());
    setCustomUntil(untilDate ? untilDate.toISOString() : "");
    setCustomActive(true);
    setCustomPanelOpen(false);
    setCustomRangeError("");
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  /* ── Guard: missing identity ── */
  if (!method || !path) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 pt-5 pb-12 sm:px-6">
        <Link
          href={`/projects/${projectSlug}/endpoints`}
          className="mb-3 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground no-underline hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={15} /> Endpoints
        </Link>
        <EmptyBlock message="No endpoint specified. Pick an endpoint from the list." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-5 pb-12 sm:px-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Link
          href={`/projects/${projectSlug}/endpoints`}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground no-underline hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={15} /> Endpoints
        </Link>
        <Button variant="outline" size="sm" onClick={copyLink} title="Copy shareable link">
          {copied ? <Check size={14} /> : <Link2 size={14} />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>

      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <MethodBadge method={method} className="text-xs" />
          <span className="font-mono text-xl font-semibold break-all text-foreground">{path}</span>
          {detail?.base_url ? <span className="text-xs text-muted-foreground">{detail.base_url}</span> : null}
        </div>
        {detail?.description ? (
          <p className="mt-2 mb-0 max-w-[720px] text-[13px] leading-relaxed text-muted-foreground">
            {detail.description}
          </p>
        ) : null}
      </header>

      <HealthStrip detail={detail} />

      <div className="flex flex-wrap items-center gap-2.5 border-t border-border py-3">
        <div className="relative inline-flex items-center gap-1.5 rounded-xl border border-border bg-card p-1">
          {TIME_RANGES.map(({ label, value }) => {
            const active = selectedRange === value && !customActive;
            return (
              <Button
                key={value}
                type="button"
                variant={active ? "outline" : "ghost"}
                size="sm"
                className={cn(
                  "h-7 rounded-lg px-2.5 text-xs font-semibold",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => pickPreset(value)}
              >
                {label}
              </Button>
            );
          })}
          <div className="relative inline-flex items-center self-center" ref={customPopoverRef}>
            <Button
              type="button"
              variant={customActive ? "outline" : "ghost"}
              size="sm"
              className={cn(
                "h-7 rounded-lg px-2.5 text-xs font-semibold",
                customActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setCustomPanelOpen((v) => !v)}
            >
              Custom
            </Button>
            {customPanelOpen && (
              <div className="absolute top-[calc(100%+8px)] right-0 z-40 w-[min(420px,92vw)] rounded-xl border border-border bg-popover p-3.5 shadow-lg">
                <div>
                  <p className="m-0 text-[13px] font-semibold text-popover-foreground">Custom time range</p>
                  <p className="m-0 mt-0.5 text-xs text-muted-foreground">Pick start and end to refine this endpoint.</p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    <span>From date</span>
                    <Input
                      type="date"
                      className="h-8 px-2 text-xs"
                      value={customSinceDraft ? customSinceDraft.slice(0, 10) : ""}
                      onChange={(e) => updateDraftPart("since", "date", e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    <span>From time</span>
                    <Input
                      type="time"
                      className="h-8 px-2 text-xs"
                      value={customSinceDraft ? customSinceDraft.slice(11, 16) : "00:00"}
                      onChange={(e) => updateDraftPart("since", "time", e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    <span>To date</span>
                    <Input
                      type="date"
                      className="h-8 px-2 text-xs"
                      value={customUntilDraft ? customUntilDraft.slice(0, 10) : ""}
                      onChange={(e) => updateDraftPart("until", "date", e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    <span>To time</span>
                    <Input
                      type="time"
                      className="h-8 px-2 text-xs"
                      value={customUntilDraft ? customUntilDraft.slice(11, 16) : "00:00"}
                      onChange={(e) => updateDraftPart("until", "time", e.target.value)}
                    />
                  </label>
                </div>
                {customRangeError ? <p className="m-0 mt-2 text-xs text-destructive">{customRangeError}</p> : null}
                <div className="mt-3 flex justify-end">
                  <Button type="button" size="sm" onClick={applyCustomRange}>Apply</Button>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Locked scope — the endpoint and app the user is already on. Shown as
          read-only chips (not part of the editable filter) so it's clear these
          can't be changed here. */}
      <div className="flex flex-wrap items-center gap-2 pt-2.5 pb-3" role="status" aria-label="Locked scope">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase text-muted-foreground">
          <Lock size={12} /> Scope
        </span>
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1 text-xs whitespace-nowrap text-foreground">
          <span className="text-[10px] font-semibold tracking-wide uppercase text-muted-foreground">Endpoint</span>
          <MethodBadge method={method} />
          <span className="truncate font-mono" title={path}>{path}</span>
        </span>
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1 text-xs whitespace-nowrap text-foreground">
          <span className="text-[10px] font-semibold tracking-wide uppercase text-muted-foreground">App</span>
          {appSlugs.length === 0 ? "All apps" : appSlugs.length === 1 ? appSlugs[0] : `${appSlugs.length} apps`}
        </span>
      </div>

      {/* Editable rich filter — explore this endpoint's data by env, status,
          consumer, latency, size, ip, ua. path/method/app are excluded (they're
          the fixed scope above). Sits above the tabs, so it applies on every tab. */}
      <div className="mt-3 mb-[18px] flex border-b border-border pb-3.5">
        <FilterBar
          projectSlug={projectSlug}
          value={filter}
          onChange={setFilter}
          exclude={["path", "method", "app"]}
        />
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(k) => setActiveTab(k as TabKey)}
        className="mb-5 w-full gap-0"
      >
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="px-3 text-[13px]">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="min-h-[200px]">
        {activeTab === "overview" ? (
          <OverviewGrid projectSlug={projectSlug} detail={detail} timeseries={timeseries} consumers={consumers} statusCodes={statusCodes} histograms={histograms} />
        ) : (
          <RequestsTab requests={recentRequests} baseUrl={detail?.base_url || ""} />
        )}
      </div>
    </div>
  );
}

/* ── Header building blocks ──────────────────────────────────────────── */

function HealthStrip({ detail }: { detail: EndpointDetail | null }) {
  const loading = detail === null;
  const errRate = detail?.error_rate || 0;
  const p95 = detail?.p95_response_time_ms || 0;
  const threshold = detail?.threshold_ms || 0;
  const apdex = detail?.apdex || 0;

  const errTone: Stat["tone"] = loading ? undefined : errRate >= 5 ? "bad" : errRate >= 1 ? "warn" : "good";
  const p95Tone: Stat["tone"] = loading || !threshold ? undefined : p95 > threshold ? "bad" : p95 > threshold * 0.75 ? "warn" : "good";
  const apdexTone: Stat["tone"] = loading ? undefined : apdex >= 0.94 ? "good" : apdex >= 0.85 ? "warn" : "bad";

  const stats: Stat[] = [
    { label: "Traffic", value: loading ? "—" : formatNumber(detail!.total_requests), sub: loading ? "" : `${(detail!.requests_per_minute || 0).toFixed(2)}/min` },
    { label: "Error rate", value: loading ? "—" : `${errRate.toFixed(2)}%`, sub: loading ? "" : `4xx ${formatNumber(detail!.client_errors || 0)} · 5xx ${formatNumber(detail!.server_errors || 0)}`, tone: errTone },
    { label: "p95 latency", value: loading ? "—" : formatMs(p95), sub: loading ? "" : `p50 ${formatMs(detail!.p50_response_time_ms)}`, tone: p95Tone },
    { label: "Apdex", value: loading ? "—" : apdex.toFixed(3), sub: loading ? "" : `${formatNumber(detail!.slow_requests)} slow`, tone: apdexTone },
  ];

  return (
    <StatStrip stats={stats} className="endpoint-page-health" />
  );
}

/* ── Overview ────────────────────────────────────────────────────────── */

function OverviewGrid({
  projectSlug,
  detail,
  timeseries,
  consumers,
  statusCodes,
  histograms,
}: {
  projectSlug: string;
  detail: EndpointDetail | null;
  timeseries: TimeseriesPoint[] | null;
  consumers: ConsumerRow[] | null;
  statusCodes: StatusCodeRow[] | null;
  histograms: Histograms | null;
}) {
  // Full-width time-series on top; the rest in two independent columns that
  // each pack tightly — this keeps side-by-side cards top-aligned and avoids
  // the row-height coupling of a rigid grid (which left gaps under short cards).
  return (
    <div className="flex flex-col gap-4">
      <TrafficSection timeseries={timeseries} />
      <LatencySection detail={detail} timeseries={timeseries} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <StatusCodesBlock statusCodes={statusCodes} />
          <ConsumersSection projectSlug={projectSlug} consumers={consumers} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <LatencyHistogramBlock histograms={histograms} />
          <DataTransferredSection detail={detail} timeseries={timeseries} histograms={histograms} />
        </div>
      </div>
    </div>
  );
}
