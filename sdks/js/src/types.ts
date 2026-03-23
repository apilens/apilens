export type Logger = {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type ApiLensRecordInput = {
  timestamp?: Date | string | number;
  environment?: string;
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
};

export type ApiLensRecord = {
  timestamp: string;
  environment: string;
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
};

export type ApiLensClientConfig = {
  apiKey?: string;
  api_key?: string;
  baseUrl?: string;
  base_url?: string;
  ingestPath?: string;
  ingest_path?: string;
  environment?: string;
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
};

export type ApiLensExpressConfig = ApiLensClientConfig & {
  client?: unknown;
  env?: string;
  clientId?: string;
  client_id?: string;
  requestLogging?: RequestLoggingConfig;
  getConsumer?: (req: unknown, res: unknown) => ApiLensConsumer | string | null | undefined;
};

export type ApiLensNextConfig = ApiLensClientConfig & {
  client?: unknown;
  env?: string;
  clientId?: string;
  client_id?: string;
  requestLogging?: RequestLoggingConfig;
  getConsumer?: (
    request: Request,
    response?: Response,
    context?: unknown,
  ) => ApiLensConsumer | string | null | undefined;
};

export type ApiLensNextEnvSummary = {
  hasApiKey: boolean;
  baseUrl: string;
  environment: string;
};
