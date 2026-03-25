'use client';

import React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface TimeRange {
  since?: string;
  until?: string;
}

interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}

const TIME_RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 },
];

export default function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const getCurrentRange = (): string => {
    if (!value.since || !value.until) return '24h';

    const since = new Date(value.since);
    const until = new Date(value.until);
    const diffMs = until.getTime() - since.getTime();
    const diffHours = Math.round(diffMs / (1000 * 60 * 60));

    const match = TIME_RANGES.find((r) => r.hours === diffHours);
    return match?.label || '24h';
  };

  const handleRangeChange = (hours: number) => {
    const until = new Date();
    const since = new Date(until.getTime() - hours * 60 * 60 * 1000);

    const newRange = {
      since: since.toISOString(),
      until: until.toISOString(),
    };

    onChange(newRange);

    // Update URL params
    const params = new URLSearchParams(searchParams.toString());
    params.set('since', newRange.since);
    params.set('until', newRange.until);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const currentRange = getCurrentRange();

  return (
    <div className="time-range-selector">
      {TIME_RANGES.map((range) => (
        <button
          key={range.label}
          type="button"
          className={`time-range-btn${currentRange === range.label ? ' active' : ''}`}
          onClick={() => handleRangeChange(range.hours)}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}
