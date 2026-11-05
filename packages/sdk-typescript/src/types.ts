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
  maxRetries?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  enabled?: boolean;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
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
