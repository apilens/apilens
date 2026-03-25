"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, Plus } from "lucide-react";
import type { AppListItem } from "@/types/app";
import type {
  AnalyticsSummary,
  AnalyticsTimeseriesPoint,
  ProjectInfo,
} from "@/lib/api-client";
import { useAuth } from "@/components/providers/AuthProvider";
import MetricsGrid from "@/components/dashboard/MetricsGrid";
import ChartContainer from "@/components/dashboard/charts/ChartContainer";
import RequestVolumeChart from "@/components/dashboard/charts/RequestVolumeChart";
import ResponseTimeChart from "@/components/dashboard/charts/ResponseTimeChart";
import TimeRangeSelector from "@/components/dashboard/filters/TimeRangeSelector";
import EnvironmentFilter from "@/components/dashboard/filters/EnvironmentFilter";

interface ProjectDetailContentProps {
  slug: string;
}

interface EndpointInsight {
  method: string;
  path: string;
  total_requests: number;
  error_count: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
}

interface TimeRange {
  since?: string;
  until?: string;
}

const EMPTY_SUMMARY: AnalyticsSummary = {
  total_requests: 0,
  error_count: 0,
  error_rate: 0,
  avg_response_time_ms: 0,
  p95_response_time_ms: 0,
  total_request_bytes: 0,
  total_response_bytes: 0,
  unique_endpoints: 0,
  unique_consumers: 0,
};

function ProjectDetailContentInner({ slug }: ProjectDetailContentProps) {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [apps, setApps] = useState<AppListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [analyticsError, setAnalyticsError] = useState("");
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [summary, setSummary] = useState<AnalyticsSummary>(EMPTY_SUMMARY);
  const [timeseries, setTimeseries] = useState<AnalyticsTimeseriesPoint[]>([]);
  const [topEndpoints, setTopEndpoints] = useState<EndpointInsight[]>([]);
  const [errorEndpoints, setErrorEndpoints] = useState<EndpointInsight[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [browserTimezone, setBrowserTimezone] = useState("UTC");
  const [timeRange, setTimeRange] = useState<TimeRange>(() => {
    const since = searchParams.get("since") || undefined;
    const until = searchParams.get("until") || undefined;

    if (since) {
      return { since, until };
    }

    return getDefaultTimeRange();
  });
  const [selectedEnv, setSelectedEnv] = useState<string | undefined>(
    searchParams.get("environment") || undefined,
  );

  const appSlugs = useMemo(() => apps.map((app) => app.slug), [apps]);
  const chartTimezone = user?.timezone || browserTimezone;
  const hasApps = apps.length > 0;
  const hasTraffic = useMemo(
    () =>
      summary.total_requests > 0 ||
      topEndpoints.length > 0 ||
      timeseries.some((point) => point.total_requests > 0),
    [summary.total_requests, topEndpoints.length, timeseries],
  );
  const health = useMemo(() => getOverviewHealth(summary), [summary]);
  const selectedWindowLabel = useMemo(
    () => formatTimeRangeLabel(timeRange, chartTimezone),
    [chartTimezone, timeRange],
  );
  const timezoneLabel = useMemo(
    () => chartTimezone.replace(/_/g, " "),
    [chartTimezone],
  );

  useEffect(() => {
    setBrowserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }, []);

  useEffect(() => {
    if (!slug) {
      setError("No project slug provided");
      setIsLoading(false);
      return;
    }

    let isMounted = true;
    const controller = new AbortController();

    async function fetchProjectData() {
      setIsLoading(true);
      setError("");

      try {
        const [projectData, appsData] = await Promise.all([
          fetchJson<ProjectInfo>(`/api/projects/${slug}`, controller.signal),
          fetchJson<{ apps?: AppListItem[] }>(
            `/api/projects/${slug}/apps`,
            controller.signal,
          ),
        ]);

        if (!isMounted) return;

        setProject(projectData);
        setApps(appsData.apps || []);
      } catch (err) {
        if (!isMounted || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : "Failed to load project");
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    fetchProjectData();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [slug]);

  useEffect(() => {
    if (!project || isLoading) {
      return;
    }

    if (!hasApps) {
      setSummary(EMPTY_SUMMARY);
      setTimeseries([]);
      setTopEndpoints([]);
      setErrorEndpoints([]);
      setAnalyticsError("");
      setAnalyticsLoading(false);
      setLastRefreshedAt(null);
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    const baseQuery = buildAnalyticsQuery({
      timeRange,
      environment: selectedEnv,
      appSlugs,
    });
    const timeseriesQuery = buildAnalyticsQuery({
      timeRange,
      environment: selectedEnv,
      appSlugs,
      timezone: chartTimezone,
    });
    const endpointsQuery = buildAnalyticsQuery({
      timeRange,
      environment: selectedEnv,
      appSlugs,
      limit: 6,
      sortBy: "total_requests",
      sortDir: "desc",
    });
    const errorQuery = buildAnalyticsQuery({
      timeRange,
      environment: selectedEnv,
      appSlugs,
      limit: 6,
      statusClasses: "4xx,5xx",
      sortBy: "error_count",
      sortDir: "desc",
    });

    async function fetchAnalytics() {
      setAnalyticsLoading(true);
      setAnalyticsError("");

      const [summaryResult, timeseriesResult, topEndpointsResult, errorEndpointsResult] =
        await Promise.allSettled([
          fetchJson(`/api/projects/${slug}/analytics/summary${baseQuery}`, controller.signal),
          fetchJson(`/api/projects/${slug}/analytics/timeseries${timeseriesQuery}`, controller.signal),
          fetchJson(`/api/projects/${slug}/analytics/endpoints${endpointsQuery}`, controller.signal),
          fetchJson(`/api/projects/${slug}/analytics/endpoints${errorQuery}`, controller.signal),
        ]);

      if (!isMounted) return;

      if (summaryResult.status === "fulfilled") {
        setSummary(normalizeSummary(summaryResult.value));
      } else {
        setSummary(EMPTY_SUMMARY);
      }

      if (timeseriesResult.status === "fulfilled") {
        setTimeseries(
          normalizeTimeseries(timeseriesResult.value, timeRange, chartTimezone),
        );
      } else {
        setTimeseries([]);
      }

      if (topEndpointsResult.status === "fulfilled") {
        setTopEndpoints(normalizeEndpointItems(topEndpointsResult.value));
      } else {
        setTopEndpoints([]);
      }

      if (errorEndpointsResult.status === "fulfilled") {
        setErrorEndpoints(normalizeEndpointItems(errorEndpointsResult.value));
      } else {
        setErrorEndpoints([]);
      }

      const failedCount = [
        summaryResult,
        timeseriesResult,
        topEndpointsResult,
        errorEndpointsResult,
      ].filter((result) => result.status === "rejected").length;

      if (failedCount === 4) {
        setAnalyticsError("Unable to load analytics for this project right now.");
      } else if (failedCount > 0) {
        setAnalyticsError("Some analytics panels could not be refreshed.");
      } else {
        setAnalyticsError("");
      }

      setLastRefreshedAt(new Date().toISOString());
      setAnalyticsLoading(false);
    }

    fetchAnalytics().catch((err) => {
      if (!isMounted || isAbortError(err)) return;
      setAnalyticsError(err instanceof Error ? err.message : "Failed to refresh analytics");
      setSummary(EMPTY_SUMMARY);
      setTimeseries([]);
      setTopEndpoints([]);
      setErrorEndpoints([]);
      setAnalyticsLoading(false);
      setLastRefreshedAt(null);
    });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [appSlugs, chartTimezone, hasApps, isLoading, project, selectedEnv, slug, timeRange]);

  if (isLoading) {
    return (
      <div className="overview-page">
        <div className="apps-page-loading">
          <Loader2 size={24} strokeWidth={2} className="animate-spin" />
          <span>Loading project overview...</span>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="overview-page">
        <div className="create-app-error">{error || "Project not found"}</div>
      </div>
    );
  }

  return (
    <div className="overview-page">
      <section className="overview-hero">
        <div className="overview-hero-copy">
          <span className="overview-kicker">Project overview</span>
          <div className="overview-heading-row">
            <h1 className="overview-title">{project.name}</h1>
            <span className="overview-status-pill" data-tone={health.tone}>
              {health.label}
            </span>
          </div>
          <p className="overview-description">
            {project.description ||
              "A focused operational snapshot of traffic, latency, and reliability across your APIs."}
          </p>

          <div className="overview-meta">
            <span>{apps.length} {apps.length === 1 ? "app" : "apps"}</span>
            <span>{formatNumber(summary.unique_endpoints)} endpoints</span>
            {lastRefreshedAt ? (
              <span>Updated {formatRefreshTime(lastRefreshedAt, chartTimezone)}</span>
            ) : null}
          </div>
        </div>

        <div className="overview-hero-side">
          <div className="overview-hero-note">
            <span className="overview-hero-note-label">Selected window</span>
            <strong className="overview-hero-note-value">{selectedWindowLabel}</strong>
            <span className="overview-hero-note-caption">
              {selectedEnv ? `Environment: ${selectedEnv}` : "All environments"} · {timezoneLabel}
            </span>
          </div>

          <Link
            href={`/projects/${slug}/new-app`}
            className="settings-btn settings-btn-primary overview-hero-action"
          >
            <Plus size={16} strokeWidth={2} />
            {hasApps ? "Create App" : "Create your first app"}
          </Link>
        </div>
      </section>

      <section className="overview-toolbar">
        <div className="dashboard-filters">
          <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
          <EnvironmentFilter
            projectSlug={slug}
            value={selectedEnv}
            onChange={setSelectedEnv}
          />
        </div>
        <p className="overview-toolbar-hint">{health.message}</p>
      </section>

      {hasApps ? (
        <MetricsGrid
          summary={summary}
          appsCount={apps.length}
          loading={analyticsLoading}
        />
      ) : null}

      {analyticsError ? (
        <div className="overview-inline-alert">{analyticsError}</div>
      ) : null}

      {!hasApps ? (
        <OverviewEmptyState
          eyebrow="No apps connected"
          title="Connect your first app to turn this page into a live overview."
          description="Once telemetry starts flowing, request volume, latency trends, and endpoint issues will appear here automatically."
          actionHref={`/projects/${slug}/new-app`}
          actionLabel="Create your first app"
        />
      ) : !analyticsLoading && !hasTraffic ? (
        <OverviewEmptyState
          eyebrow="No traffic in this window"
          title="This project is connected, but there’s nothing to review yet."
          description="Try a wider time range or send a request through one of your apps. The overview will refresh as new traffic arrives."
          secondaryText={`${selectedWindowLabel}${selectedEnv ? ` · ${selectedEnv}` : ""}`}
          actionHref={`/projects/${slug}/endpoints`}
          actionLabel="Open endpoints explorer"
        />
      ) : (
        <>
          <section className="dashboard-charts-grid">
            <ChartContainer
              title="Request volume"
              span={2}
              loading={analyticsLoading}
              info="Traffic over the selected time window."
            >
              <RequestVolumeChart data={timeseries} timezone={chartTimezone} />
            </ChartContainer>

            <ChartContainer
              title="Latency trend"
              span={2}
              loading={analyticsLoading}
              info="Average and 95th percentile latency."
            >
              <ResponseTimeChart data={timeseries} timezone={chartTimezone} />
            </ChartContainer>
          </section>

          <section className="overview-insights-grid">
            <EndpointInsightCard
              title="Highest traffic endpoints"
              description="The routes carrying the most load in the selected window."
              items={topEndpoints}
              loading={analyticsLoading}
              variant="traffic"
            />

            <EndpointInsightCard
              title="Reliability watch"
              description="Endpoints contributing the most errors right now."
              items={errorEndpoints}
              loading={analyticsLoading}
              variant="errors"
            />
          </section>

          <div className="overview-footer">
            <Link href={`/projects/${slug}/endpoints`} className="overview-inline-link">
              Open the full endpoints explorer
              <ArrowRight size={16} strokeWidth={2} />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function EndpointInsightCard({
  title,
  description,
  items,
  loading,
  variant,
}: {
  title: string;
  description: string;
  items: EndpointInsight[];
  loading: boolean;
  variant: "traffic" | "errors";
}) {
  return (
    <section className="overview-insight-card">
      <div className="overview-insight-header">
        <div>
          <h2 className="overview-insight-title">{title}</h2>
          <p className="overview-insight-description">{description}</p>
        </div>
      </div>

      <div className="overview-insight-list">
        {loading
          ? Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className="overview-insight-row overview-insight-row-skeleton"
                aria-hidden="true"
              >
                <div className="overview-insight-skeleton-main" />
                <div className="overview-insight-skeleton-metrics" />
              </div>
            ))
          : items.length > 0
            ? items.slice(0, 5).map((item) => {
                const errorRate =
                  item.total_requests > 0
                    ? (item.error_count / item.total_requests) * 100
                    : 0;

                return (
                  <div
                    key={`${variant}-${item.method}-${item.path}`}
                    className="overview-insight-row"
                  >
                    <div className="overview-insight-row-main">
                      <div className="overview-endpoint">
                        <span className="endpoint-method">{item.method}</span>
                        <span className="overview-endpoint-path">{item.path}</span>
                      </div>

                      <p className="overview-insight-row-subtext">
                        {variant === "traffic"
                          ? `${formatNumber(item.total_requests)} requests in the selected window`
                          : `${formatNumber(item.error_count)} errors across ${formatNumber(item.total_requests)} requests`}
                      </p>
                    </div>

                    <div className="overview-insight-row-value">
                      {variant === "traffic" ? (
                        <>
                          <strong>{formatNumber(item.total_requests)}</strong>
                          <span>P95 {Math.round(item.p95_response_time_ms)} ms</span>
                        </>
                      ) : (
                        <>
                          <strong
                            className={
                              errorRate >= 5
                                ? "tone-bad"
                                : errorRate >= 2
                                  ? "tone-warn"
                                  : ""
                            }
                          >
                            {errorRate.toFixed(1)}%
                          </strong>
                          <span>{formatNumber(item.error_count)} errors</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            : (
              <p className="overview-insight-empty">
                {variant === "traffic"
                  ? "No endpoint traffic was recorded in this window."
                  : "No error-heavy endpoints were found in this window."}
              </p>
            )}
      </div>
    </section>
  );
}

function OverviewEmptyState({
  eyebrow,
  title,
  description,
  secondaryText,
  actionHref,
  actionLabel,
}: {
  eyebrow: string;
  title: string;
  description: string;
  secondaryText?: string;
  actionHref: string;
  actionLabel: string;
}) {
  return (
    <section className="overview-empty-state">
      <span className="overview-kicker">{eyebrow}</span>
      <h2 className="overview-empty-title">{title}</h2>
      <p className="overview-empty-description">{description}</p>
      {secondaryText ? (
        <p className="overview-empty-secondary">{secondaryText}</p>
      ) : null}
      <Link href={actionHref} className="settings-btn settings-btn-primary">
        {actionLabel}
      </Link>
    </section>
  );
}

function buildAnalyticsQuery({
  timeRange,
  environment,
  appSlugs,
  limit,
  statusClasses,
  sortBy,
  sortDir,
  timezone,
}: {
  timeRange: TimeRange;
  environment?: string;
  appSlugs?: string[];
  limit?: number;
  statusClasses?: string;
  sortBy?: string;
  sortDir?: string;
  timezone?: string;
}) {
  const params = new URLSearchParams();

  if (timeRange.since) params.set("since", timeRange.since);
  if (timeRange.until) params.set("until", timeRange.until);
  if (environment) params.set("environment", environment);
  if (appSlugs && appSlugs.length > 0) {
    params.set("app_slugs", appSlugs.join(","));
  }
  if (typeof limit === "number") params.set("limit", String(limit));
  if (statusClasses) params.set("status_classes", statusClasses);
  if (sortBy) params.set("sort_by", sortBy);
  if (sortDir) params.set("sort_dir", sortDir);
  if (timezone) params.set("timezone", timezone);

  const query = params.toString();
  return query ? `?${query}` : "";
}

function normalizeSummary(data: any): AnalyticsSummary {
  return {
    total_requests: Number(data?.total_requests) || 0,
    error_count: Number(data?.error_count) || 0,
    error_rate: Number(data?.error_rate) || 0,
    avg_response_time_ms: Number(data?.avg_response_time_ms) || 0,
    p95_response_time_ms: Number(data?.p95_response_time_ms) || 0,
    total_request_bytes: Number(data?.total_request_bytes) || 0,
    total_response_bytes: Number(data?.total_response_bytes) || 0,
    unique_endpoints: Number(data?.unique_endpoints) || 0,
    unique_consumers: Number(data?.unique_consumers) || 0,
  };
}

function normalizeTimeseries(
  data: any,
  timeRange?: TimeRange,
  timezone?: string,
): AnalyticsTimeseriesPoint[] {
  const items = Array.isArray(data) ? data : data?.items || [];
  const normalizedItems: AnalyticsTimeseriesPoint[] = items.map(
    (point: any): AnalyticsTimeseriesPoint => ({
    bucket: point.bucket,
    total_requests: Number(point.total_requests) || 0,
    error_count: Number(point.error_count) || 0,
    error_rate: Number(point.error_rate) || 0,
    avg_response_time_ms:
      Number(point.total_requests) > 0
        ? Number(point.avg_response_time_ms) || 0
        : null,
    p95_response_time_ms:
      Number(point.total_requests) > 0
        ? Number(point.p95_response_time_ms) || 0
        : null,
    total_request_bytes: Number(point.total_request_bytes) || 0,
    total_response_bytes: Number(point.total_response_bytes) || 0,
  }),
  );

  const buckets = buildHourlyBuckets(timeRange, timezone);
  if (buckets.length <= 1) {
    return normalizedItems;
  }

  const itemMap = new Map(
    normalizedItems.map((point) => [new Date(point.bucket).toISOString(), point]),
  );

  return buckets.map((bucket): AnalyticsTimeseriesPoint => {
    const existing = itemMap.get(bucket);
    if (existing) {
      return existing;
    }

    return {
      bucket,
      total_requests: 0,
      error_count: 0,
      error_rate: 0,
      avg_response_time_ms: null,
      p95_response_time_ms: null,
      total_request_bytes: 0,
      total_response_bytes: 0,
    };
  });
}

function normalizeEndpointItems(data: any): EndpointInsight[] {
  const items = Array.isArray(data) ? data : data?.items || [];
  return items.map((item: any) => ({
    method: item.method || "GET",
    path: item.path || "/",
    total_requests: Number(item.total_requests) || 0,
    error_count: Number(item.error_count) || 0,
    avg_response_time_ms: Number(item.avg_response_time_ms) || 0,
    p95_response_time_ms: Number(item.p95_response_time_ms) || 0,
  }));
}

function getDefaultTimeRange(): TimeRange {
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
  };
}

function getOverviewHealth(summary: AnalyticsSummary) {
  if (summary.total_requests === 0) {
    return {
      label: "Waiting for traffic",
      tone: "neutral",
      message: "The overview updates automatically once this project starts receiving traffic.",
    };
  }

  if (summary.error_rate >= 5 || summary.p95_response_time_ms >= 1200) {
    return {
      label: "Needs attention",
      tone: "critical",
      message:
        "Reliability or tail latency is elevated in the selected window. Use the endpoint panels below to isolate the source quickly.",
    };
  }

  if (summary.error_rate >= 2 || summary.p95_response_time_ms >= 600) {
    return {
      label: "Watch closely",
      tone: "warning",
      message:
        "Core signals are mostly stable, but latency or error rate is trending above a comfortable range.",
    };
  }

  return {
    label: "Healthy",
    tone: "good",
    message:
      "Traffic, latency, and error rate look healthy for the selected window.",
  };
}

function getDateTimeFormatOptions(timezone?: string) {
  if (!timezone) {
    return {};
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return { timeZone: timezone };
  } catch {
    return {};
  }
}

const HOUR_MS = 60 * 60 * 1000;

function buildHourlyBuckets(timeRange?: TimeRange, timezone?: string): string[] {
  if (!timeRange?.since || !timeRange?.until) {
    return [];
  }

  const start = new Date(timeRange.since);
  const endExclusive = new Date(timeRange.until);

  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime())) {
    return [];
  }

  const inclusiveEnd = new Date(endExclusive.getTime() - 1);
  if (inclusiveEnd < start) {
    return [];
  }

  const firstBucket = floorToHourInTimeZone(start, timezone);
  const lastBucket = floorToHourInTimeZone(inclusiveEnd, timezone);
  const buckets: string[] = [];

  for (
    let cursor = firstBucket.getTime();
    cursor <= lastBucket.getTime();
    cursor += HOUR_MS
  ) {
    buckets.push(new Date(cursor).toISOString());
  }

  return buckets;
}

function floorToHourInTimeZone(date: Date, timezone?: string): Date {
  const zonedTimestamp = date.getTime() + getTimeZoneOffsetMs(date, timezone);
  const flooredZonedTimestamp = Math.floor(zonedTimestamp / HOUR_MS) * HOUR_MS;
  return zonedLocalTimestampToUtcDate(flooredZonedTimestamp, timezone);
}

function zonedLocalTimestampToUtcDate(
  localTimestamp: number,
  timezone?: string,
): Date {
  if (!timezone) {
    return new Date(localTimestamp);
  }

  let guess = new Date(localTimestamp);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getTimeZoneOffsetMs(guess, timezone);
    const nextGuess = new Date(localTimestamp - offset);

    if (Math.abs(nextGuess.getTime() - guess.getTime()) < 1) {
      return nextGuess;
    }

    guess = nextGuess;
  }

  return guess;
}

function getTimeZoneOffsetMs(date: Date, timezone?: string): number {
  if (!timezone) {
    return 0;
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

    const parts = formatter.formatToParts(date);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );

    const zonedTimestamp = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );

    return zonedTimestamp - date.getTime();
  } catch {
    return 0;
  }
}

function formatTimeRangeLabel(timeRange: TimeRange, timezone?: string): string {
  if (!timeRange.since || !timeRange.until) {
    return "Last 24 hours";
  }

  const since = new Date(timeRange.since);
  const until = new Date(timeRange.until);
  const diffHours = Math.round(
    (until.getTime() - since.getTime()) / (1000 * 60 * 60),
  );

  if (diffHours === 1) return "Last 1 hour";
  if (diffHours === 6) return "Last 6 hours";
  if (diffHours === 24) return "Last 24 hours";
  if (diffHours === 168) return "Last 7 days";
  if (diffHours === 720) return "Last 30 days";

  return `${since.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...getDateTimeFormatOptions(timezone),
  })} to ${until.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...getDateTimeFormatOptions(timezone),
  })}`;
}

function formatRefreshTime(timestamp: string, timezone?: string) {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...getDateTimeFormatOptions(timezone),
  });
}

function formatNumber(value: number | undefined): string {
  if (value == null) return "0";
  return Number(value).toLocaleString();
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Request failed");
  }

  return response.json();
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export default function ProjectDetailContent({
  slug,
}: ProjectDetailContentProps) {
  return (
    <Suspense
      fallback={
        <div className="overview-page">
          <div className="apps-page-loading">
            <Loader2 size={24} strokeWidth={2} className="animate-spin" />
            <span>Loading project overview...</span>
          </div>
        </div>
      }
    >
      <ProjectDetailContentInner slug={slug} />
    </Suspense>
  );
}
