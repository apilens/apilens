/**
 * Format large numbers with K/M suffixes
 * @example formatNumber(1234) => "1.2K"
 * @example formatNumber(1234567) => "1.2M"
 */
export const formatNumber = (n: number): string => {
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1) + 'M';
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + 'K';
  }
  return n.toString();
};

/**
 * Format bytes to human-readable sizes
 * @example formatBytes(1024) => "1.0 KB"
 * @example formatBytes(1048576) => "1.0 MB"
 */
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

/**
 * Format ISO timestamp to readable time
 * @example formatTimestamp("2024-01-15T10:30:00Z") => "10:30 AM"
 */
function getTimeZoneOption(timezone?: string) {
  if (!timezone) {
    return {};
  }

  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return { timeZone: timezone };
  } catch {
    return {};
  }
}

export const formatTimestamp = (iso: string, timezone?: string): string => {
  const date = new Date(iso);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...getTimeZoneOption(timezone),
  });
};

/**
 * Format ISO timestamp to readable date and time
 * @example formatDatetime("2024-01-15T10:30:00Z") => "Jan 15, 10:30 AM"
 */
export const formatDatetime = (iso: string, timezone?: string): string => {
  const date = new Date(iso);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...getTimeZoneOption(timezone),
  });
};

/**
 * Truncate endpoint path for display in charts
 * @example truncateEndpoint("GET", "/api/v1/users/profile", 30) => "GET /api/v1/users/..."
 */
export const truncateEndpoint = (method: string, path: string, maxLen: number = 40): string => {
  const full = `${method} ${path}`;
  if (full.length <= maxLen) return full;

  // Try to keep method and beginning of path
  const truncated = `${method} ${path.substring(0, maxLen - method.length - 6)}...`;
  return truncated;
};

/**
 * Format percentage with 1 decimal place
 * @example formatPercent(0.1234) => "12.3%"
 */
export const formatPercent = (value: number): string => {
  return (value * 100).toFixed(1) + '%';
};

/**
 * Format milliseconds to readable duration
 * @example formatDuration(1500) => "1.5s"
 * @example formatDuration(250) => "250ms"
 */
export const formatDuration = (ms: number): string => {
  if (ms >= 1000) {
    return (ms / 1000).toFixed(1) + 's';
  }
  return Math.round(ms) + 'ms';
};

/**
 * Aggregate endpoints by status class (2xx, 3xx, 4xx, 5xx)
 */
export const aggregateByStatusClass = (endpoints: Array<{ status_code: number; total_requests: number }>) => {
  const aggregated: Record<string, number> = {
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
  };

  endpoints.forEach((endpoint) => {
    const statusClass = Math.floor(endpoint.status_code / 100) + 'xx';
    if (aggregated[statusClass] !== undefined) {
      aggregated[statusClass] += endpoint.total_requests;
    }
  });

  return Object.entries(aggregated)
    .filter(([_, count]) => count > 0)
    .map(([statusClass, count]) => ({
      name: statusClass,
      value: count,
    }));
};

/**
 * Aggregate endpoints by HTTP method
 */
export const aggregateByMethod = (endpoints: Array<{ method: string; total_requests: number }>) => {
  const aggregated: Record<string, number> = {};

  endpoints.forEach((endpoint) => {
    if (!aggregated[endpoint.method]) {
      aggregated[endpoint.method] = 0;
    }
    aggregated[endpoint.method] += endpoint.total_requests;
  });

  return Object.entries(aggregated)
    .map(([method, count]) => ({
      name: method,
      value: count,
    }))
    .sort((a, b) => b.value - a.value);
};
