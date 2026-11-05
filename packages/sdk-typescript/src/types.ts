export type Logger = {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type ApiLensRecordInput = {
  timestamp?: Date | string | number;
  environment?: string;
  project_slug?: string;
  app_id?: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  request_size?: number;
  response_size?: number;
  ip_address?: string;
  user_agent?: string;
  consumer_id?: string;
  consumer_name?: string;
  consumer_group?: string;
  request_payload?: string;
  response_payload?: string;
  request_headers?: string;
  response_headers?: string;
  release?: string;
  commit?: string;
};

export type ApiLensRecord = {
  timestamp: string;
  environment: string;
  project_slug: string;
  app_id: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  request_size: number;
  response_size: number;
  ip_address: string;
  user_agent: string;
  consumer_id: string;
  consumer_name: string;
  consumer_group: string;
  request_payload: string;
  response_payload: string;
  request_headers: string;
  response_headers: string;
  release: string;
  commit: string;
};

export type ApiLensClientConfig = {
  apiKey?: string;
  api_key?: string;
  projectSlug?: string;
  project_slug?: string;
  appId?: string;
  app_id?: string;
  baseUrl?: string;
  base_url?: string;
  ingestPath?: string;
  ingest_path?: string;
  environment?: string;
  /**
   * Deploy correlation, stamped on every record. When omitted they are read
   * from the environment: APILENS_RELEASE; APILENS_COMMIT / GIT_COMMIT /
   * SOURCE_VERSION / RENDER_GIT_COMMIT / VERCEL_GIT_COMMIT_SHA / HEROKU_SLUG_COMMIT.
   */
  release?: string;
  commit?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  maxQueueSize?: number;
  /**
   * Memory cap for the queue, in estimated bytes (default 64 MB). When full,
   * the oldest records are dropped (counted as `queue_bytes`).
   */
  maxQueueBytes?: number;
  /**
   * Upper bound for one ingest request body before compression (default
   * 4 MB). Batches are cut at `batchSize` or this, whichever comes first; a
   * single larger record is truncated, payloads first (counted as `truncated`).
   */
  maxBatchBytes?: number;
  /** Gzip request bodies to ingest (default true). */
  compress?: boolean;
  maxRetries?: number;
  /** Full-jitter exponential backoff for 408/429/5xx/network errors. */
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  enabled?: boolean;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Called with a `stats()` snapshot after every flush (e.g. to export metrics). */
  onStats?: (stats: ApiLensClientStats) => void;
};

export type ApiLensDropReason =
  | "queue_full"
  | "queue_bytes"
  | "non_retryable"
  | "retries_exhausted"
  | "truncated";

export type ApiLensClientStats = {
  queuedRecords: number;
  queuedBytes: number;
  sentBatches: number;
  sentRecords: number;
  failedBatches: number;
  /** Records lost for any reason (sum of dropCounts minus `truncated`). */
  droppedCount: number;
  dropCounts: Record<ApiLensDropReason, number>;
  lastError: string | null;
  /** ISO 8601 time of the last accepted batch. */
  lastSuccessAt: string | null;
};

export type ApiLensConsumer = {
  id?: string;
  identifier?: string;
  name?: string;
  group?: string;
  consumer_id?: string;
  consumer_name?: string;
  consumer_group?: string;
};

export type RequestLoggingConfig = {
  logRequestBody?: boolean;
  logResponseBody?: boolean;
  capturePayloads?: boolean;
  maxPayloadBytes?: number;
  /**
   * Capture request/response headers as JSON (default true). Values of
   * built-in sensitive headers are always sent as `[redacted]`; the blob is
   * capped at 8 KB.
   */
  captureHeaders?: boolean;
};

export type ApiLensExpressConfig = ApiLensClientConfig & {
  client?: unknown;
  env?: string;
  clientId?: string;
  client_id?: string;
  requestLogging?: RequestLoggingConfig;
  /**
   * Regexes (case-insensitive, searched against the request path without the
   * query string) whose matching requests bypass capture entirely. A string is
   * split on commas. `APILENS_EXCLUDE_PATHS` adds patterns on top.
   */
  excludePaths?: string | ReadonlyArray<string | RegExp>;
  /** Regexes (case-insensitive) on the User-Agent header; matches bypass capture. */
  excludeUserAgents?: string | ReadonlyArray<string | RegExp>;
  /**
   * Apply the built-in health-check / probe exclusions (default true). See
   * `DEFAULT_EXCLUDED_PATHS` and `DEFAULT_EXCLUDED_USER_AGENTS`.
   */
  defaultExclusions?: boolean;
  getConsumer?: (req: unknown, res: unknown) => ApiLensConsumer | string | null | undefined;
};
