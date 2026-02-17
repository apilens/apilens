"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { ConsumerRequestStat } from "@/lib/api-client";

interface ConsumerDetailContentProps {
  appSlug: string;
  consumerSlug: string;
}

const TIME_RANGES = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
] as const;

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "--";
  const hasZone = /([zZ]|[+-]\d{2}:\d{2})$/.test(dateStr);
  const then = new Date(hasZone ? dateStr : `${dateStr}Z`).getTime();
  if (Number.isNaN(then)) return "--";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export default function ConsumerDetailContent({
  appSlug,
  consumerSlug,
}: ConsumerDetailContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const consumer = decodeURIComponent(consumerSlug);

  const initialSince = searchParams.get("since");
  const initialRange = useMemo(() => {
    if (!initialSince) return 24;
    const diffHours = Math.max(
      1,
      Math.round((Date.now() - new Date(initialSince).getTime()) / (1000 * 60 * 60)),
    );
    return TIME_RANGES.find((item) => item.value === diffHours)?.value || 24;
  }, [initialSince]);

  const [selectedRange, setSelectedRange] = useState(initialRange);
  const [rows, setRows] = useState<ConsumerRequestStat[]>([]);
  const [loading, setLoading] = useState(true);

  const since = useMemo(
    () => new Date(Date.now() - selectedRange * 60 * 60 * 1000).toISOString(),
    [selectedRange],
  );

  const summary = useMemo(() => {
    const totalRequests = rows.reduce((sum, row) => sum + row.total_requests, 0);
    const totalErrors = rows.reduce((sum, row) => sum + row.error_count, 0);
    const reqPerMin = totalRequests / Math.max(1, selectedRange * 60);
    const avgErrorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
    const avgLatency =
      totalRequests > 0
        ? rows.reduce((sum, row) => sum + row.avg_response_time_ms * row.total_requests, 0) / totalRequests
        : 0;
    return { totalRequests, totalErrors, reqPerMin, avgErrorRate, avgLatency };
  }, [rows, selectedRange]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("consumer", consumer);
      params.set("since", since);
      params.set("limit", "250");
      const res = await fetch(`/api/apps/${appSlug}/consumers/requests?${params.toString()}`);
      if (!res.ok) {
        setRows([]);
        return;
      }
      const data = (await res.json()) as ConsumerRequestStat[];
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, [appSlug, consumer, since]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  return (
    <div className="page-content endpoints-page consumers-page">
      <div className="endpoints-toolbar">
        <button
          type="button"
          className="endpoints-page-btn"
          onClick={() => router.push(`/apps/${appSlug}/consumers`)}
        >
          <ArrowLeft size={14} />
          Back to consumers
        </button>
        <div className="time-range tabs-inline">
          {TIME_RANGES.map((range) => (
            <button
              key={range.value}
              type="button"
              className={`time-range-btn${selectedRange === range.value ? " active" : ""}`}
              onClick={() => setSelectedRange(range.value)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <section className="consumers-detail-header">
        <h2>{consumer}</h2>
        <p>Associated endpoint traffic</p>
      </section>

      <section className="endpoints-summary-grid">
        <article className="summary-card">
          <p className="summary-label">Total requests</p>
          <p className="summary-value">{formatNumber(summary.totalRequests)}</p>
        </article>
        <article className="summary-card">
          <p className="summary-label">Requests / min</p>
          <p className="summary-value">{summary.reqPerMin.toFixed(2)}</p>
        </article>
        <article className="summary-card">
          <p className="summary-label">Total errors</p>
          <p className="summary-value">{formatNumber(summary.totalErrors)}</p>
        </article>
        <article className="summary-card">
          <p className="summary-label">Error rate</p>
          <p className="summary-value">{summary.avgErrorRate.toFixed(1)}%</p>
        </article>
        <article className="summary-card">
          <p className="summary-label">Avg latency</p>
          <p className="summary-value">{summary.avgLatency.toFixed(0)} ms</p>
        </article>
        <article className="summary-card">
          <p className="summary-label">Affected endpoints</p>
          <p className="summary-value">{formatNumber(rows.length)}</p>
        </article>
      </section>

      <div className="endpoints-table-wrap">
        {loading ? (
          <div className="endpoints-loading">Loading request history...</div>
        ) : rows.length === 0 ? (
          <div className="endpoints-empty">
            <div className="endpoints-empty-copy">
              <h3>No request history</h3>
              <p>No associated requests were found for this consumer in the selected range.</p>
            </div>
          </div>
        ) : (
          <div className="endpoints-table-wrapper">
            <table className="endpoints-table">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Requests</th>
                  <th>Errors</th>
                  <th>Error rate</th>
                  <th>Avg latency</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.method}-${row.path}`}>
                    <td>
                      <span className={`method-badge method-badge-${row.method.toLowerCase()}`}>
                        {row.method}
                      </span>
                      <span className="endpoint-path">{row.path}</span>
                    </td>
                    <td className="stat-value">{formatNumber(row.total_requests)}</td>
                    <td className="stat-value">{formatNumber(row.error_count)}</td>
                    <td className="stat-value">{row.error_rate.toFixed(1)}%</td>
                    <td className="stat-value">{row.avg_response_time_ms.toFixed(0)} ms</td>
                    <td className="stat-value">{relativeTime(row.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
