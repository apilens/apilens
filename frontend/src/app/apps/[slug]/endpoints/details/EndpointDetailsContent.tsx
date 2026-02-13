"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  EndpointConsumer,
  EndpointDetail,
  EndpointStatusCode,
  EndpointTimeseriesPoint,
} from "@/lib/api-client";

interface EndpointDetailsContentProps {
  appSlug: string;
}

const RANGES = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
] as const;

type MetricMode = "requests" | "errors" | "latency";

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function EndpointDetailsContent({ appSlug }: EndpointDetailsContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const method = searchParams.get("method") || "GET";
  const path = searchParams.get("path") || "/";

  const [rangeHours, setRangeHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [timeseries, setTimeseries] = useState<EndpointTimeseriesPoint[]>([]);
  const [consumers, setConsumers] = useState<EndpointConsumer[]>([]);
  const [statusCodes, setStatusCodes] = useState<EndpointStatusCode[]>([]);
  const [metricMode, setMetricMode] = useState<MetricMode>("requests");
  const [activeBucket, setActiveBucket] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const since = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();
        const qs = `method=${encodeURIComponent(method)}&path=${encodeURIComponent(path)}&since=${encodeURIComponent(since)}`;
        const requests = [
          fetch(`/api/apps/${appSlug}/analytics/endpoint-detail?${qs}`),
          fetch(`/api/apps/${appSlug}/analytics/endpoint-timeseries?${qs}`),
          fetch(`/api/apps/${appSlug}/analytics/endpoint-consumers?${qs}&limit=8`),
          fetch(`/api/apps/${appSlug}/analytics/endpoint-status-codes?${qs}&limit=10`),
        ] as const;

        const [detailResult, tsResult, consumersResult, statusResult] = await Promise.allSettled(requests);

        if (detailResult.status === "fulfilled" && detailResult.value.ok) {
          setDetail(await detailResult.value.json());
        } else {
          setDetail({
            method,
            path,
            total_requests: 0,
            error_count: 0,
            error_rate: 0,
            avg_response_time_ms: 0,
            p95_response_time_ms: 0,
            total_request_bytes: 0,
            total_response_bytes: 0,
            last_seen_at: null,
          });
        }

        if (tsResult.status === "fulfilled" && tsResult.value.ok) {
          const ts = (await tsResult.value.json()) as EndpointTimeseriesPoint[];
          setTimeseries(ts);
          setActiveBucket(Math.max(0, ts.length - 1));
        } else {
          setTimeseries([]);
          setActiveBucket(0);
        }

        if (consumersResult.status === "fulfilled" && consumersResult.value.ok) setConsumers(await consumersResult.value.json());
        else setConsumers([]);

        if (statusResult.status === "fulfilled" && statusResult.value.ok) setStatusCodes(await statusResult.value.json());
        else setStatusCodes([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [appSlug, method, path, rangeHours]);

  const derived = useMemo(() => {
    const totalRequests = detail?.total_requests || 0;
    const errorCount = detail?.error_count || 0;
    const requestsPerMin = totalRequests / Math.max(1, rangeHours * 60);
    const successRequests = Math.max(0, totalRequests - errorCount);
    const topConsumer = consumers[0];
    const topConsumerShare = topConsumer && totalRequests > 0 ? (topConsumer.total_requests / totalRequests) * 100 : 0;
    const topStatus = statusCodes[0];

    const chartData = timeseries.map((point) => {
      const value = metricMode === "requests"
        ? point.total_requests
        : metricMode === "errors"
          ? point.error_count
          : point.avg_response_time_ms;
      return {
        label: new Date(point.bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        value,
        point,
      };
    });

    const chartMax = Math.max(1, ...chartData.map((d) => d.value));
    const active = chartData[Math.min(activeBucket, Math.max(0, chartData.length - 1))] || null;

    const clientErrors = statusCodes
      .filter((s) => s.status_code >= 400 && s.status_code < 500)
      .reduce((a, s) => a + s.total_requests, 0);
    const serverErrors = statusCodes
      .filter((s) => s.status_code >= 500)
      .reduce((a, s) => a + s.total_requests, 0);

    return {
      totalRequests,
      errorCount,
      requestsPerMin,
      successRequests,
      topConsumer,
      topConsumerShare,
      topStatus,
      chartData,
      chartMax,
      active,
      clientErrors,
      serverErrors,
    };
  }, [activeBucket, consumers, detail, metricMode, rangeHours, statusCodes, timeseries]);

  if (loading && !detail) {
    return <div className="endpoint-details-loading">Loading endpoint details...</div>;
  }

  return (
    <div className="endpoint-details-page">
      <div className="endpoint-details-topbar">
        <button type="button" className="endpoint-back-btn" onClick={() => router.push(`/apps/${appSlug}/endpoints`)}>
          Back to Endpoints
        </button>
        <div className="endpoint-details-range">
          {RANGES.map((r) => (
            <button
              key={r.hours}
              type="button"
              className={`endpoint-details-range-btn${rangeHours === r.hours ? " active" : ""}`}
              onClick={() => setRangeHours(r.hours)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="endpoint-details-head">
        <span className={`method-badge method-badge-${method.toLowerCase()}`}>{method}</span>
        <h2>{path}</h2>
      </div>

      <div className="endpoint-details-summary-grid endpoint-details-summary-grid-4">
        <div className="endpoint-summary-card"><p>Total requests</p><strong>{fmtNum(derived.totalRequests)}</strong></div>
        <div className="endpoint-summary-card"><p>Requests / min</p><strong>{derived.requestsPerMin.toFixed(2)}</strong></div>
        <div className="endpoint-summary-card"><p>Error rate</p><strong>{detail?.error_rate?.toFixed(1) || 0}%</strong></div>
        <div className="endpoint-summary-card"><p>P95 latency</p><strong>{detail?.p95_response_time_ms?.toFixed(0) || 0} ms</strong></div>
      </div>

      <div className="endpoint-details-panels endpoint-details-panels-main">
        <section className="endpoint-panel">
          <div className="endpoint-panel-head">
            <h3>Activity explorer</h3>
            <div className="endpoint-metric-switch">
              <button type="button" className={metricMode === "requests" ? "active" : ""} onClick={() => setMetricMode("requests")}>Requests</button>
              <button type="button" className={metricMode === "errors" ? "active" : ""} onClick={() => setMetricMode("errors")}>Errors</button>
              <button type="button" className={metricMode === "latency" ? "active" : ""} onClick={() => setMetricMode("latency")}>Latency</button>
            </div>
          </div>
          <div className="endpoint-bars-grid">
            {derived.chartData.map((item, idx) => (
              <button
                key={`${item.label}-${idx}`}
                type="button"
                className={`endpoint-bar-col${idx === activeBucket ? " active" : ""}`}
                onMouseEnter={() => setActiveBucket(idx)}
                onFocus={() => setActiveBucket(idx)}
              >
                <div className="endpoint-bar-track">
                  <span style={{ height: `${(item.value / derived.chartMax) * 100}%` }} />
                </div>
                <p>{item.label}</p>
              </button>
            ))}
          </div>
          {derived.active && (
            <div className="endpoint-active-point">
              <span>{derived.active.label}</span>
              <strong>
                {metricMode === "latency"
                  ? `${derived.active.value.toFixed(0)} ms`
                  : fmtNum(Math.round(derived.active.value))}
              </strong>
            </div>
          )}
        </section>

        <section className="endpoint-panel">
          <h3>What to do now</h3>
          <div className="endpoint-advice-list">
            <div className="endpoint-advice-item">
              <p>Top consumer concentration</p>
              <strong>{derived.topConsumer ? `${derived.topConsumer.consumer} (${derived.topConsumerShare.toFixed(1)}%)` : "No dominant consumer"}</strong>
            </div>
            <div className="endpoint-advice-item">
              <p>Error pressure</p>
              <strong>{fmtNum(derived.clientErrors)} client / {fmtNum(derived.serverErrors)} server</strong>
            </div>
            <div className="endpoint-advice-item">
              <p>Most common status</p>
              <strong>{derived.topStatus ? `${derived.topStatus.status_code} (${fmtNum(derived.topStatus.total_requests)})` : "No status data"}</strong>
            </div>
            <div className="endpoint-advice-item">
              <p>Transfer footprint</p>
              <strong>{fmtBytes(detail?.total_request_bytes || 0)} in / {fmtBytes(detail?.total_response_bytes || 0)} out</strong>
            </div>
          </div>
        </section>
      </div>

      <div className="endpoint-details-panels endpoint-details-panels-bottom">
        <section className="endpoint-panel">
          <h3>Connected users</h3>
          <div className="endpoint-list-rows">
            {consumers.map((consumer) => (
              <div key={consumer.consumer} className="endpoint-list-row">
                <span>{consumer.consumer}</span>
                <div className="endpoint-line-track"><span style={{ width: `${derived.totalRequests > 0 ? (consumer.total_requests / derived.totalRequests) * 100 : 0}%` }} /></div>
                <strong>{fmtNum(consumer.total_requests)}</strong>
              </div>
            ))}
            {consumers.length === 0 && <p className="endpoint-empty-note">No consumer activity in this range.</p>}
          </div>
        </section>

        <section className="endpoint-panel">
          <h3>Status distribution</h3>
          <div className="endpoint-list-rows">
            {statusCodes.map((status) => (
              <div key={status.status_code} className="endpoint-list-row">
                <span>{status.status_code}</span>
                <div className="endpoint-line-track"><span style={{ width: `${derived.totalRequests > 0 ? (status.total_requests / derived.totalRequests) * 100 : 0}%` }} /></div>
                <strong>{fmtNum(status.total_requests)}</strong>
              </div>
            ))}
            {statusCodes.length === 0 && <p className="endpoint-empty-note">No status data in this range.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
