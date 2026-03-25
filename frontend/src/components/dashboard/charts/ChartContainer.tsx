'use client';

import React from 'react';

interface ChartContainerProps {
  title: string;
  span?: 1 | 2 | 3 | 4;
  loading?: boolean;
  error?: string;
  children: React.ReactNode;
  info?: string;
}

export default function ChartContainer({
  title,
  span = 1,
  loading = false,
  error,
  children,
  info,
}: ChartContainerProps) {
  return (
    <div className="chart-container" data-span={span}>
      <div className="chart-header">
        <h3 className="chart-title">{title}</h3>
        {info && (
          <span className="chart-info" title={info}>
            ⓘ
          </span>
        )}
      </div>

      <div className="chart-content">
        {error ? (
          <div className="chart-error">
            <p className="error-message">⚠️ {error}</p>
            <button
              className="retry-button"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="chart-skeleton">
            <div className="skeleton-bar"></div>
            <div className="skeleton-bar"></div>
            <div className="skeleton-bar"></div>
            <div className="skeleton-text"></div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
