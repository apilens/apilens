'use client';

import React, { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts';
import { formatNumber, truncateEndpoint } from './chartUtils';
import { CHART_COLORS } from './chartColors';

interface EndpointStat {
  method: string;
  path: string;
  status_code: number;
  total_requests: number;
  error_count: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
}

interface TopErrorEndpointsChartProps {
  projectSlug: string;
  timeRange?: { since?: string; until?: string };
  environment?: string;
  appSlugs?: string[];
}

export default function TopErrorEndpointsChart({
  projectSlug,
  timeRange,
  environment,
  appSlugs = [],
}: TopErrorEndpointsChartProps) {
  const [data, setData] = useState<EndpointStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('limit', '10');
        params.set('sort_by', 'error_count');
        params.set('sort_dir', 'desc');
        params.set('status_classes', '4xx,5xx');

        if (timeRange?.since) params.set('since', timeRange.since);
        if (timeRange?.until) params.set('until', timeRange.until);
        if (environment) params.set('environment', environment);
        if (appSlugs.length > 0) params.set('app_slugs', appSlugs.join(','));

        const res = await fetch(`/api/projects/${projectSlug}/analytics/endpoints?${params.toString()}`);
        if (res.ok) {
          const result = await res.json();
          setData(result.items || []);
        }
      } catch (err) {
        console.error('Failed to fetch error endpoints:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [projectSlug, timeRange, environment, appSlugs]);

  if (loading || !data || data.length === 0) {
    return (
      <div style={{ width: '100%', height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {loading ? 'Loading data...' : 'No errors found'}
        </p>
      </div>
    );
  }

  // Transform data for horizontal bar chart
  const chartData = data.map((ep) => ({
    name: truncateEndpoint(ep.method, ep.path, 50),
    errors: ep.error_count,
    errorRate: ep.total_requests > 0 ? ((ep.error_count / ep.total_requests) * 100).toFixed(1) : '0.0',
  }));

  const renderCustomLabel = (props: any) => {
    const { x, y, width, value, errorRate } = props;
    return (
      <text
        x={x + width + 5}
        y={y + 10}
        fill="var(--text-muted)"
        fontSize={10}
        textAnchor="start"
      >
        {errorRate}%
      </text>
    );
  };

  return (
    <div style={{ width: '100%', height: '300px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 10, right: 40, left: 150, bottom: 10 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" opacity={0.3} />
        <XAxis
          type="number"
          tickFormatter={formatNumber}
          stroke="var(--text-muted)"
          style={{ fontSize: 12 }}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={140}
          stroke="var(--text-muted)"
          style={{ fontSize: 11 }}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '8px 12px',
          }}
          formatter={(value: any, name: any) => {
            if (name === 'Errors') return [formatNumber(value), name];
            return [value, name];
          }}
        />
        <Bar dataKey="errors" name="Errors" fill={CHART_COLORS.danger} radius={[0, 4, 4, 0]}>
          <LabelList dataKey="errorRate" content={renderCustomLabel} />
        </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
