'use client';

import React from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { aggregateByMethod } from './chartUtils';
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

interface MethodDistributionChartProps {
  endpoints: EndpointStat[];
  loading?: boolean;
}

export default function MethodDistributionChart({ endpoints, loading }: MethodDistributionChartProps) {
  if (loading || !endpoints || endpoints.length === 0) {
    return (
      <div style={{ width: '100%', height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {loading ? 'Loading data...' : 'No data available'}
        </p>
      </div>
    );
  }

  const data = aggregateByMethod(endpoints);

  if (data.length === 0) {
    return (
      <div style={{ width: '100%', height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No method data available</p>
      </div>
    );
  }

  const renderLabel = (entry: any) => {
    const total = data.reduce((sum, item) => sum + item.value, 0);
    const percent = ((entry.value / total) * 100).toFixed(1);
    return `${entry.name}: ${percent}%`;
  };

  return (
    <div style={{ width: '100%', height: '300px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={90}
          paddingAngle={2}
          dataKey="value"
          label={renderLabel}
          labelLine={{ stroke: 'var(--text-muted)', strokeWidth: 1 }}
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={getMethodColor(entry.name)} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '8px 12px',
          }}
          formatter={(value: any) => [value.toLocaleString(), 'Requests']}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
          iconType="circle"
        />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
