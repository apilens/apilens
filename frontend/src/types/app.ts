export interface App {
  id: string;
  name: string;
  slug: string;
  icon_url: string;
  description: string;
  framework: "fastapi" | "flask" | "django" | "starlette";
  created_at: string;
  updated_at: string;
}

export interface AppListItem {
  id: string;
  name: string;
  slug: string;
  icon_url: string;
  description: string;
  framework: "fastapi" | "flask" | "django" | "starlette";
  api_key_count: number;
  created_at: string;
}

export interface Environment {
  id: string;
  name: string;
  slug: string;
  color: string;
  order: number;
  created_at: string;
  updated_at: string;
}

export interface EndpointStats {
  method: string;
  path: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
  last_seen_at: string | null;
}

export interface EndpointStatsListResponse {
  items: EndpointStats[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface EndpointOption {
  method: string;
  path: string;
  total_requests: number;
}
