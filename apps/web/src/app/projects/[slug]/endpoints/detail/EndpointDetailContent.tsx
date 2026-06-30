"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, Filter, Link2 } from "lucide-react";
import {
  Button,
  StatStrip,
  Tabs,
  type Stat,
} from "@/components/aperture";
import {
  ConsumersSection,
  DataTransferredSection,
  EMPTY_DETAIL,
  EMPTY_HISTOGRAMS,
  LatencyHistogramBlock,
  LatencySection,
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
  const [selectedEnv, setSelectedEnv] = useState<string>(() => searchParams.get("env") || "");
  const [environments, setEnvironments] = useState<string[]>([]);

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

  const rangeLabel = customActive
    ? customUntil
      ? `${new Date(customSince).toLocaleString()} – ${new Date(customUntil).toLocaleString()}`
      : `Since ${new Date(customSince).toLocaleString()}`
    : TIME_RANGES.find((r) => r.value === selectedRange)?.label || `${selectedRange}h`;

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
    if (selectedEnv) params.set("env", selectedEnv);
    if (appSlugs.length) params.set("apps", appSlugs.join(","));
    if (activeTab !== "overview") params.set("tab", activeTab);
    router.replace(`/projects/${projectSlug}/endpoints/detail?${params.toString()}`, { scroll: false });
  }, [method, path, selectedRange, selectedEnv, appSlugs, activeTab, customActive, customSince, customUntil, projectSlug, router]);

  // Available environments for the dropdown.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/environments`);
        if (res.ok) {
          const data = await res.json();
          setEnvironments(data.environments || []);
        }
      } catch {
        /* non-fatal */
      }
    })();
  }, [projectSlug]);

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
    if (selectedEnv) params.set("environment", selectedEnv);
    return params;
  }, [method, path, appSlugs, timeParams, selectedEnv]);

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
      <div className="endpoint-page">
        <Link href={`/projects/${projectSlug}/endpoints`} className="endpoint-page-back">
          <ArrowLeft size={15} /> Endpoints
        </Link>
        <div className="endpoint-detail-empty">No endpoint specified. Pick an endpoint from the list.</div>
      </div>
    );
  }

  return (
    <div className="endpoint-page">
      <div className="endpoint-page-topbar">
        <Link href={`/projects/${projectSlug}/endpoints`} className="endpoint-page-back">
          <ArrowLeft size={15} /> Endpoints
        </Link>
        <Button variant="secondary" size="sm" onClick={copyLink} title="Copy shareable link">
          {copied ? <Check size={14} /> : <Link2 size={14} />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>

      <header className="endpoint-page-header">
        <div className="endpoint-page-identity">
          <span className={`method-badge method-badge-${method.toLowerCase()}`}>{method}</span>
          <span className="endpoint-page-path">{path}</span>
          {detail?.base_url ? <span className="endpoint-detail-baseurl">{detail.base_url}</span> : null}
        </div>
        {detail?.description ? <p className="endpoint-page-description">{detail.description}</p> : null}
      </header>

      <HealthStrip detail={detail} />

      <div className="endpoint-page-filters">
        <div className="time-range-selector">
          {TIME_RANGES.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              className={`time-range-btn${selectedRange === value && !customActive ? " active" : ""}`}
              onClick={() => pickPreset(value)}
            >
              {label}
            </button>
          ))}
          <div className="custom-time-anchor" ref={customPopoverRef}>
            <button
              type="button"
              className={`time-range-btn${customActive ? " active" : ""}`}
              onClick={() => setCustomPanelOpen((v) => !v)}
            >
              Custom
            </button>
            {customPanelOpen && (
              <div className="custom-range-panel">
                <div className="custom-range-header">
                  <div>
                    <p className="custom-range-title">Custom time range</p>
                    <p className="custom-range-subtitle">Pick start and end to refine this endpoint.</p>
                  </div>
                </div>
                <div className="custom-range-fields custom-range-fields-4">
                  <label className="custom-range-field">
                    <span>From date</span>
                    <input type="date" value={customSinceDraft ? customSinceDraft.slice(0, 10) : ""} onChange={(e) => updateDraftPart("since", "date", e.target.value)} />
                  </label>
                  <label className="custom-range-field">
                    <span>From time</span>
                    <input type="time" value={customSinceDraft ? customSinceDraft.slice(11, 16) : "00:00"} onChange={(e) => updateDraftPart("since", "time", e.target.value)} />
                  </label>
                  <label className="custom-range-field">
                    <span>To date</span>
                    <input type="date" value={customUntilDraft ? customUntilDraft.slice(0, 10) : ""} onChange={(e) => updateDraftPart("until", "date", e.target.value)} />
                  </label>
                  <label className="custom-range-field">
                    <span>To time</span>
                    <input type="time" value={customUntilDraft ? customUntilDraft.slice(11, 16) : "00:00"} onChange={(e) => updateDraftPart("until", "time", e.target.value)} />
                  </label>
                </div>
                {customRangeError ? <p className="custom-range-error">{customRangeError}</p> : null}
                <div className="custom-range-actions">
                  <button type="button" className="custom-range-apply" onClick={applyCustomRange}>Apply</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {environments.length > 0 ? (
          <select className="environment-dropdown" value={selectedEnv} onChange={(e) => setSelectedEnv(e.target.value)}>
            <option value="">All environments</option>
            {environments.map((env) => (
              <option key={env} value={env}>{env}</option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="endpoint-active-filters" role="status" aria-label="Active filters">
        <span className="endpoint-active-label">
          <Filter size={13} /> Active filters
        </span>
        <span className="endpoint-active-chip">
          <span className="endpoint-active-key">Time</span> {rangeLabel}
        </span>
        <span className="endpoint-active-chip">
          <span className="endpoint-active-key">Env</span> {selectedEnv || "All"}
        </span>
        <span className="endpoint-active-chip">
          <span className="endpoint-active-key">Apps</span>{" "}
          {appSlugs.length === 0 ? "All" : appSlugs.length === 1 ? appSlugs[0] : `${appSlugs.length} selected`}
        </span>
      </div>

      <Tabs
        className="endpoint-page-tabs"
        tabs={TABS}
        active={activeTab}
        onChange={(k) => setActiveTab(k as TabKey)}
      />

      <div className="endpoint-page-body">
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
    { label: "Error rate", value: loading ? "—" : `${errRate.toFixed(2)}%`, sub: loading ? "" : `${formatNumber(detail!.error_count)} errors`, tone: errTone },
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
    <div className="endpoint-overview">
      <TrafficSection timeseries={timeseries} />
      <LatencySection detail={detail} timeseries={timeseries} />
      <div className="endpoint-overview-cols">
        <div className="endpoint-overview-col">
          <StatusCodesBlock statusCodes={statusCodes} />
          <ConsumersSection projectSlug={projectSlug} consumers={consumers} />
        </div>
        <div className="endpoint-overview-col">
          <LatencyHistogramBlock histograms={histograms} />
          <DataTransferredSection detail={detail} timeseries={timeseries} histograms={histograms} />
        </div>
      </div>
    </div>
  );
}
