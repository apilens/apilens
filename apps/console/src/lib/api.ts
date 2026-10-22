import "server-only";

/**
 * Typed client for the Go query API (`docs/architecture`, query role).
 * Server-only: the read key never reaches the browser. Configuration is read
 * per request, so one image works in every environment.
 */

export type Range = "1h" | "6h" | "24h" | "7d";
export type StatusClass = "all" | "2xx" | "3xx" | "4xx" | "5xx";

export interface Project {
  org: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string };
  apps: { id: string; slug: string; name: string }[];
  environments: string[];
}

export interface TrafficSummary {
  range: Range;
  from: string;
  to: string;
  requests: number;
  client_errors: number;
  server_errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  requests_per_minute: number;
}

export interface TimeseriesPoint {
  ts: string;
  requests: number;
  client_errors: number;
  server_errors: number;
  p95_ms: number;
}

export interface Timeseries {
  range: Range;
  bucket_seconds: number;
  points: TimeseriesPoint[];
}

export interface EndpointStat {
  method: string;
  path: string;
  requests: number;
  client_errors: number;
  server_errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
}

export interface RequestRow {
  timestamp: string;
  method: string;
  path: string;
  raw_path: string;
  status_code: number;
  response_time_ms: number;
  environment: string;
  consumer_id: string;
  consumer_name: string;
  trace_id: string;
}

export interface ErrorGroup {
  method: string;
  path: string;
  status_code: number;
  count: number;
  consumers: number;
  last_seen: string;
}

export interface Span {
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  service_name: string;
  start: string;
  duration_ms: number;
  status: string;
  status_code: number;
  attributes: Record<string, string>;
}

export interface TraceLog {
  timestamp: string;
  level: string;
  message: string;
  span_id: string;
}

export interface Trace {
  trace_id: string;
  spans: Span[];
  logs: TraceLog[];
}

export interface Deploy {
  deployed_at: string;
  release: string;
  commit: string;
  environment: string;
  url: string;
}

export interface Meta {
  name: string;
  version: string;
  commit?: string;
  roles: string[];
}

export type ApiErrorKind = "unconfigured" | "unauthorized" | "unreachable" | "not_found" | "server";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly baseUrl: string;

  constructor(kind: ApiErrorKind, message: string, baseUrl: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.baseUrl = baseUrl;
    this.status = status;
  }
}

function config() {
  const baseUrl = (process.env.APILENS_API_URL || "http://localhost:8080").replace(/\/+$/, "");
  const readKey = process.env.APILENS_READ_KEY?.trim() ?? "";
  return { baseUrl, readKey };
}

type Query = Record<string, string | number | undefined>;

async function get<T>(path: string, query: Query = {}): Promise<T> {
  const { baseUrl, readKey } = config();
  if (!readKey) {
    throw new ApiError("unconfigured", "APILENS_READ_KEY is not set", baseUrl);
  }
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${readKey}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError("unreachable", `Could not reach ${baseUrl}`, baseUrl);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ApiError("unauthorized", "The read key was rejected", baseUrl, res.status);
  }
  if (res.status === 404) {
    throw new ApiError("not_found", "Not found", baseUrl, res.status);
  }
  if (!res.ok) {
    throw new ApiError("server", `The API answered HTTP ${res.status}`, baseUrl, res.status);
  }
  return (await res.json()) as T;
}

export interface Filters {
  range: Range;
  env?: string;
}

export const api = {
  project: () => get<Project>("/api/v1/project"),
  summary: (f: Filters) => get<TrafficSummary>("/api/v1/traffic/summary", { range: f.range, env: f.env }),
  timeseries: (f: Filters) => get<Timeseries>("/api/v1/traffic/timeseries", { range: f.range, env: f.env }),
  endpoints: (f: Filters) =>
    get<{ endpoints: EndpointStat[] }>("/api/v1/traffic/endpoints", { range: f.range, env: f.env, limit: 100 }),
  requests: (f: Filters & { status: StatusClass; path?: string }) =>
    get<{ requests: RequestRow[] }>("/api/v1/requests", {
      range: f.range,
      env: f.env,
      status: f.status,
      path: f.path,
      limit: 100,
    }),
  errors: (f: Filters) => get<{ errors: ErrorGroup[] }>("/api/v1/errors", { range: f.range, env: f.env }),
  trace: (traceId: string) => get<Trace>(`/api/v1/traces/${encodeURIComponent(traceId)}`),
  deploys: (f: Pick<Filters, "range">) => get<{ deploys: Deploy[] }>("/api/v1/deploys", { range: f.range }),
};

/** Build metadata; unauthenticated. Null when the API is down. */
export async function getMeta(): Promise<Meta | null> {
  const { baseUrl } = config();
  try {
    const res = await fetch(`${baseUrl}/api/v1/meta`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    return res.ok ? ((await res.json()) as Meta) : null;
  } catch {
    return null;
  }
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** Await a call and capture ApiErrors as values so pages can render a state. */
export async function settle<T>(p: Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await p };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e };
    throw e;
  }
}

/** Public ingest URL shown on the setup page. */
export function publicIngestUrl(): string {
  return (process.env.APILENS_PUBLIC_INGEST_URL || "http://localhost:8080").replace(/\/+$/, "");
}
