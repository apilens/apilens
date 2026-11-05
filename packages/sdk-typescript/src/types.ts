import type { SampleOnRequest, SampleOnResponse } from "./sampling.js";

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
  /** Endpoint grouping path (route template, e.g. `/orders/{id}`). */
  path: string;
  /** Exact path as received, with the (redacted) query string. Defaults to `path`. */
  raw_path?: string;
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
  /**
   * False when the request was sampled out: the base record is still sent
   * (it counts in metrics) but headers and payloads are dropped. Default true.
   */
  sampled?: boolean;
};

export type ApiLensRecord = {
  timestamp: string;
  environment: string;
  project_slug: string;
  app_id: string;
  method: string;
  path: string;
  raw_path: string;
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
  sampled: boolean;
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
  /*
   * PII redaction. Each list holds regexes (strings or `RegExp`, matched
   * case-insensitively anywhere in the NAME; anchor for exact matches) that
   * EXTEND the built-in `DEFAULT_MASK_*` patterns, which always apply. Matching
   * values become `[redacted]` before the record is queued. An invalid regex
   * throws when the middleware is created.
   */
  /** Query-parameter names to redact (on top of `DEFAULT_MASK_QUERY_PARAMS`). */
  redactQueryParams?: ReadonlyArray<string | RegExp>;
  /** Header names to redact (on top of `SENSITIVE_HEADERS` / `DEFAULT_MASK_HEADER_PATTERNS`). */
  redactHeaders?: ReadonlyArray<string | RegExp>;
  /** JSON body field names to redact, at any depth (on top of `DEFAULT_MASK_BODY_FIELDS`). */
  redactBodyFields?: ReadonlyArray<string | RegExp>;
  /*
   * Sampling. A sampled-out request still sends its base record with
   * `sampled: false` (so traffic, error and latency metrics are unchanged);
   * only headers and bodies are dropped. See `sampling.ts`.
   */
  /** Probability in [0, 1] that a request keeps its detail (default 1). Throws if out of range. */
  sampleRate?: number;
  /**
   * Runs when the request arrives. `true`/`false` is final, a number is a
   * probability, `undefined`/`null` falls back to `sampleRate`. Throwing
   * counts as `undefined`.
   */
  sampleOnRequest?: SampleOnRequest;
  /**
   * Runs after the response (status, latency, consumer). Same return values;
   * `undefined` keeps the prior decision. Cannot resurrect a request sampled
   * out at request time.
   */
  sampleOnResponse?: SampleOnResponse;
  /**
   * Parametrize id-looking segments (`/orders/42` → `/orders/{id}`) when no
   * Express route matched (default true). `APILENS_PARAMETRIZE_PATHS=false`
   * turns it off regardless. Matched route templates are always used.
   */
  parametrizePaths?: boolean;
  getConsumer?: (req: unknown, res: unknown) => ApiLensConsumer | string | null | undefined;
};
