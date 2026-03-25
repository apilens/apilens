'use client';

import React from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { formatDatetime, formatTimestamp, formatDuration, formatNumber } from './chartUtils';
import { CHART_COLORS } from './chartColors';

interface TimeseriesPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
}

interface ResponseTimeChartProps {
  data: TimeseriesPoint[];
  loading?: boolean;
  timezone?: string;
}

const SINGLE_POINT_PANEL: React.CSSProperties = {
  width: '100%',
  maxWidth: '480px',
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '14px',
  textAlign: 'center',
};

const SINGLE_POINT_META: React.CSSProperties = {
  fontSize: '12px',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const SINGLE_POINT_STATS: React.CSSProperties = {
  width: '100%',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: '10px',
};

const SINGLE_POINT_STAT: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '16px',
  border: '1px solid var(--border-color)',
  borderRadius: '12px',
  background: 'var(--bg-tertiary)',
  textAlign: 'left',
};

const SINGLE_POINT_STAT_LABEL: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
};

const SINGLE_POINT_LABEL: React.CSSProperties = {
  margin: 0,
  fontSize: '14px',
  color: 'var(--text-secondary)',
};

const SINGLE_POINT_HINT: React.CSSProperties = {
  margin: 0,
  fontSize: '13px',
  lineHeight: 1.5,
  color: 'var(--text-muted)',
};

export default function ResponseTimeChart({
  data,
  loading,
  timezone,
}: ResponseTimeChartProps) {
  if (loading || !data || data.length === 0) {
    return (
      <div style={{ width: '100%', height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {loading ? 'Loading data...' : 'No data available'}
        </p>
      </div>
    );
  }

  if (data.length === 1) {
    const point = data[0];

    return (
      <div style={SINGLE_POINT_PANEL}>
        <span style={SINGLE_POINT_META}>
          {formatDatetime(point.bucket, timezone)}
        </span>
        <div style={SINGLE_POINT_STATS}>
          <div style={SINGLE_POINT_STAT}>
            <span style={SINGLE_POINT_STAT_LABEL}>Avg latency</span>
            <strong
              style={{
                fontSize: '28px',
                lineHeight: 1.1,
                fontWeight: 600,
                color: CHART_COLORS.info,
              }}
            >
              {formatDuration(point.avg_response_time_ms)}
            </strong>
          </div>
          <div style={SINGLE_POINT_STAT}>
            <span style={SINGLE_POINT_STAT_LABEL}>P95 latency</span>
            <strong
              style={{
                fontSize: '28px',
                lineHeight: 1.1,
                fontWeight: 600,
                color: CHART_COLORS.danger,
              }}
            >
              {formatDuration(point.p95_response_time_ms)}
            </strong>
          </div>
        </div>
        <p style={SINGLE_POINT_LABEL}>
          Based on {formatNumber(point.total_requests)} requests in this interval
        </p>
        <p style={SINGLE_POINT_HINT}>
          Only one interval is available right now. The latency trend appears after the next bucket lands.
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '300px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="p95Gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_COLORS.danger} stopOpacity={0.3} />
            <stop offset="95%" stopColor={CHART_COLORS.warning} stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" opacity={0.3} />
        <XAxis
          dataKey="bucket"
          tickFormatter={(value) => formatTimestamp(value, timezone)}
          stroke="var(--text-muted)"
          style={{ fontSize: 12 }}
        />
        <YAxis
          tickFormatter={(value) => `${value}ms`}
          stroke="var(--text-muted)"
          style={{ fontSize: 12 }}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '8px 12px',
          }}
          labelFormatter={(value) => formatTimestamp(value as string, timezone)}
          formatter={(value: any, name: any) => [formatDuration(value), name]}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
          iconType="line"
        />
        <Area
          type="monotone"
          dataKey="p95_response_time_ms"
          name="P95 Latency"
          stroke={CHART_COLORS.danger}
          strokeWidth={2}
          fill="url(#p95Gradient)"
        />
        <Line
          type="monotone"
          dataKey="avg_response_time_ms"
          name="Avg Latency"
          stroke={CHART_COLORS.info}
          strokeWidth={2}
          dot={false}
        />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
