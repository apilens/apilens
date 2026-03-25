export const CHART_COLORS = {
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#0070f3',
  neutral: '#6b7280',
  methods: {
    GET: '#3b82f6',
    POST: '#22c55e',
    PUT: '#f59e0b',
    PATCH: '#a855f7',
    DELETE: '#ef4444',
    HEAD: '#6b7280',
    OPTIONS: '#8b5cf6',
  },
  statusClasses: {
    '2xx': '#22c55e',
    '3xx': '#3b82f6',
    '4xx': '#f59e0b',
    '5xx': '#ef4444',
  },
  gradient: {
    blue: ['#0070f3', '#0051cc'],
    green: ['#22c55e', '#16a34a'],
    red: ['#ef4444', '#dc2626'],
    orange: ['#f59e0b', '#d97706'],
  },
};

export const getMethodColor = (method: string): string => {
  return CHART_COLORS.methods[method as keyof typeof CHART_COLORS.methods] || CHART_COLORS.neutral;
};

export const getStatusColor = (statusCode: number): string => {
  if (statusCode >= 200 && statusCode < 300) return CHART_COLORS.statusClasses['2xx'];
  if (statusCode >= 300 && statusCode < 400) return CHART_COLORS.statusClasses['3xx'];
  if (statusCode >= 400 && statusCode < 500) return CHART_COLORS.statusClasses['4xx'];
  if (statusCode >= 500) return CHART_COLORS.statusClasses['5xx'];
  return CHART_COLORS.neutral;
};

export const getStatusClassColor = (statusClass: string): string => {
  return CHART_COLORS.statusClasses[statusClass as keyof typeof CHART_COLORS.statusClasses] || CHART_COLORS.neutral;
};
