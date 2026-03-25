'use client';

import React from 'react';
import { formatBytes } from './charts/chartUtils';

interface AnalyticsSummary {
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
  total_request_bytes?: number;
  total_response_bytes?: number;
  unique_endpoints?: number;
  unique_consumers?: number;
}

interface MetricsGridProps {
  summary: AnalyticsSummary;
  appsCount?: number;
  loading?: boolean;
}

export default function MetricsGrid({ summary, appsCount = 0, loading = false }: MetricsGridProps) {
  if (loading) {
    return (
      <section className="overview-metrics-grid" aria-label="Project metrics loading">
        {Array.from({ length: 4 }).map((_, index) => (
          <article key={index} className="overview-metric-card overview-metric-card-skeleton" aria-hidden="true">
            <div className="overview-metric-skeleton-label" />
            <div className="overview-metric-skeleton-value" />
            <div className="overview-metric-skeleton-note" />
          </article>
        ))}
      </section>
    );
  }

  const totalBytes = (summary.total_request_bytes || 0) + (summary.total_response_bytes || 0);
  const metrics = [
    {
      label: 'Requests',
      value: formatNumber(summary.total_requests),
      note: `${formatNumber(summary.unique_endpoints)} endpoints active`,
    },
    {
      label: 'Error rate',
      value: `${summary.error_rate.toFixed(1)}%`,
      note: `${formatNumber(summary.error_count)} failed requests`,
      tone: summary.error_rate >= 5 ? 'bad' : summary.error_rate >= 2 ? 'warn' : 'good',
    },
    {
      label: 'Avg latency',
      value: `${Math.round(summary.avg_response_time_ms)} ms`,
      note: `P95 ${Math.round(summary.p95_response_time_ms)} ms`,
    },
    {
      label: 'Transfer',
      value: formatBytes(totalBytes),
      note: `${formatNumber(appsCount)} apps monitored`,
    },
  ];

  return (
    <section className="overview-metrics-grid" aria-label="Project metrics">
      {metrics.map((metric) => (
        <article key={metric.label} className="overview-metric-card">
          <p className="overview-metric-label">{metric.label}</p>
          <p
            className={`overview-metric-value ${
              metric.tone === 'bad' ? 'tone-bad' : metric.tone === 'warn' ? 'tone-warn' : metric.tone === 'good' ? 'tone-good' : ''
            }`}
          >
            {metric.value}
          </p>
          <p className="overview-metric-note">{metric.note}</p>
        </article>
      ))}
    </section>
  );
}

function formatNumber(value: number | undefined): string {
  if (value == null) return '0';
  return Number(value).toLocaleString();
}
