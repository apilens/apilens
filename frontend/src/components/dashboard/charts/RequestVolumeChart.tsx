'use client';

import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { formatDatetime, formatNumber, formatTimestamp } from './chartUtils';
import { CHART_COLORS } from './chartColors';

interface TimeseriesPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
}

interface RequestVolumeChartProps {
  data: TimeseriesPoint[];
  loading?: boolean;
  timezone?: string;
}

const SINGLE_POINT_PANEL: React.CSSProperties = {
  width: '100%',
  maxWidth: '460px',
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

const SINGLE_POINT_VALUE: React.CSSProperties = {
  fontSize: '56px',
  lineHeight: 1,
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const SINGLE_POINT_LABEL: React.CSSProperties = {
  margin: 0,
  fontSize: '15px',
  color: 'var(--text-secondary)',
};

const SINGLE_POINT_STATS: React.CSSProperties = {
  width: '100%',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: '10px',
  marginTop: '4px',
};

const SINGLE_POINT_STAT: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '14px 16px',
  border: '1px solid var(--border-color)',
  borderRadius: '12px',
  background: 'var(--bg-tertiary)',
  textAlign: 'left',
};

const SINGLE_POINT_STAT_LABEL: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
};

const SINGLE_POINT_STAT_VALUE: React.CSSProperties = {
  fontSize: '22px',
  lineHeight: 1.1,
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const SINGLE_POINT_HINT: React.CSSProperties = {
  margin: 0,
  fontSize: '13px',
  lineHeight: 1.5,
  color: 'var(--text-muted)',
};

export default function RequestVolumeChart({
  data,
  loading,
  timezone,
}: RequestVolumeChartProps) {
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
        <div style={SINGLE_POINT_VALUE}>
          {formatNumber(point.total_requests)}
        </div>
        <p style={SINGLE_POINT_LABEL}>Requests in this interval</p>
        <div style={SINGLE_POINT_STATS}>
          <div style={SINGLE_POINT_STAT}>
            <span style={SINGLE_POINT_STAT_LABEL}>Errors</span>
            <strong style={SINGLE_POINT_STAT_VALUE}>
              {formatNumber(point.error_count)}
            </strong>
          </div>
          <div style={SINGLE_POINT_STAT}>
            <span style={SINGLE_POINT_STAT_LABEL}>Error rate</span>
            <strong style={SINGLE_POINT_STAT_VALUE}>
              {point.error_rate.toFixed(1)}%
            </strong>
          </div>
        </div>
        <p style={SINGLE_POINT_HINT}>
          Only one interval is available right now. The trend appears as soon as the next bucket lands.
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '300px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="requestGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_COLORS.info} stopOpacity={0.3} />
            <stop offset="95%" stopColor={CHART_COLORS.info} stopOpacity={0} />
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
          tickFormatter={formatNumber}
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
          formatter={(value: any) => [formatNumber(value), 'Requests']}
        />
        <Area
          type="monotone"
          dataKey="total_requests"
          stroke={CHART_COLORS.info}
          strokeWidth={2}
          fill="url(#requestGradient)"
        />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
