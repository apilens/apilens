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
  Cell,
} from 'recharts';
import { formatNumber, truncateEndpoint } from './chartUtils';
import { getMethodColor } from './chartColors';

interface EndpointStat {
  method: string;
  path: string;
  status_code: number;
  total_requests: number;
  error_count: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
}

interface TopEndpointsBarChartProps {
  projectSlug: string;
  timeRange?: { since?: string; until?: string };
  environment?: string;
  appSlugs?: string[];
}

export default function TopEndpointsBarChart({
  projectSlug,
  timeRange,
  environment,
  appSlugs = [],
}: TopEndpointsBarChartProps) {
  const [data, setData] = useState<EndpointStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('limit', '10');
        params.set('sort_by', 'total_requests');
        params.set('sort_dir', 'desc');

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
        console.error('Failed to fetch top endpoints:', err);
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
          {loading ? 'Loading data...' : 'No endpoints found'}
        </p>
      </div>
    );
  }

  // Transform data for horizontal bar chart
  const chartData = data.map((ep) => ({
    name: truncateEndpoint(ep.method, ep.path, 50),
    requests: ep.total_requests,
    method: ep.method,
  }));

  return (
    <div style={{ width: '100%', height: '300px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 10, right: 30, left: 150, bottom: 10 }}
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
          formatter={(value: any) => [formatNumber(value), 'Requests']}
        />
        <Bar dataKey="requests" radius={[0, 4, 4, 0]}>
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={getMethodColor(entry.method)} />
          ))}
        </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
