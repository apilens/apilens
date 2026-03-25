'use client';

import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { formatNumber, formatTimestamp } from './chartUtils';
import { CHART_COLORS } from './chartColors';

interface TimeseriesPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
}

interface ErrorRateTrendChartProps {
  data: TimeseriesPoint[];
  loading?: boolean;
  timezone?: string;
}

export default function ErrorRateTrendChart({
  data,
  loading,
  timezone,
}: ErrorRateTrendChartProps) {
  if (loading || !data || data.length === 0) {
    return (
      <div style={{ width: '100%', height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {loading ? 'Loading data...' : 'No data available'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '300px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" opacity={0.3} />
        <XAxis
          dataKey="bucket"
          tickFormatter={(value) => formatTimestamp(value, timezone)}
          stroke="var(--text-muted)"
          style={{ fontSize: 12 }}
        />
        <YAxis
          yAxisId="left"
          tickFormatter={formatNumber}
          stroke="var(--text-muted)"
          style={{ fontSize: 12 }}
          label={{ value: 'Count', angle: -90, position: 'insideLeft', style: { fill: 'var(--text-muted)' } }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          domain={[0, 'auto']}
          tickFormatter={(value) => `${value}%`}
          stroke="var(--text-muted)"
          style={{ fontSize: 12 }}
          label={{ value: 'Rate %', angle: 90, position: 'insideRight', style: { fill: 'var(--text-muted)' } }}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '8px 12px',
          }}
          labelFormatter={(value) => formatTimestamp(value as string, timezone)}
          formatter={(value: any, name: any) => {
            if (name === 'Error Count') return [formatNumber(value), name];
            return [`${value.toFixed(1)}%`, name];
          }}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
          iconType="line"
        />
        <ReferenceLine
          yAxisId="right"
          y={5}
          stroke={CHART_COLORS.warning}
          strokeDasharray="5 5"
          strokeOpacity={0.5}
          label={{ value: '5% threshold', position: 'right', style: { fontSize: 11, fill: 'var(--text-muted)' } }}
        />
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="error_count"
          name="Error Count"
          stroke={CHART_COLORS.danger}
          strokeWidth={2}
          dot={false}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="error_rate"
          name="Error Rate"
          stroke={CHART_COLORS.warning}
          strokeWidth={2}
          strokeDasharray="5 5"
          dot={false}
        />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
