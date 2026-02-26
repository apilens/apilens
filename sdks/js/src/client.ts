import {
  isNonEmptyString,
  normalizePath,
  sleep,
  toISO8601,
  toNonNegativeInt,
  toNumber,
} from "./utils.js";
import type {
  ApiLensClientConfig,
  ApiLensRecord,
  ApiLensRecordInput,
  Logger,
} from "./types.js";

const SDK_VERSION = "0.1.2";

type RequiredConfig = {
  apiKey: string;
  baseUrl: string;
  ingestPath: string;
  environment: string;
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
  maxQueueSize: number;
  maxRetries: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  enabled: boolean;
  userAgent: string;
  fetchImpl: typeof fetch;
  logger: Logger;
};

function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (typeof fetchImpl === "function") {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error(
    "No fetch implementation found. Use Node.js 18+ or provide fetchImpl.",
  );
}

function normalizeRecord(
  input: ApiLensRecordInput,
  defaultEnvironment: string,
): ApiLensRecord {
  const payload = input || ({} as ApiLensRecordInput);
  return {
    timestamp: toISO8601(payload.timestamp),
    environment: String(payload.environment || defaultEnvironment || "production"),
    method: String(payload.method || "GET").toUpperCase(),
    path: normalizePath(payload.path || "/"),
    status_code: toNonNegativeInt(payload.status_code, 0),
    response_time_ms: Math.max(toNumber(payload.response_time_ms, 0), 0),
    request_size: toNonNegativeInt(payload.request_size, 0),
    response_size: toNonNegativeInt(payload.response_size, 0),
    ip_address: String(payload.ip_address || ""),
    user_agent: String(payload.user_agent || ""),
    consumer_id: String(payload.consumer_id || ""),
    consumer_name: String(payload.consumer_name || ""),
    consumer_group: String(payload.consumer_group || ""),
    request_payload: String(payload.request_payload || ""),
    response_payload: String(payload.response_payload || ""),
  };
}

class ApiLensClient {
  private static instance?: ApiLensClient;

  public static getInstance(): ApiLensClient {
    if (!ApiLensClient.instance) {
      throw new Error("ApiLensClient is not initialized");
    }
    return ApiLensClient.instance;
  }

  public static async shutdown(): Promise<void> {
    if (ApiLensClient.instance) {
      await ApiLensClient.instance.handleShutdown();
    }
  }

  public config: RequiredConfig;
  public queue: ApiLensRecord[];
  public droppedCount: number;
  private flushIntervalId?: NodeJS.Timeout;

  constructor(config: ApiLensClientConfig = {}) {
    if (ApiLensClient.instance) {
      throw new Error("ApiLensClient is already initialized");
    }

    this.config = {
      apiKey: String(config.apiKey || config.api_key || "").trim(),
      baseUrl: String(
        config.baseUrl || config.base_url || "https://api.apilens.ai/api/v1",
      ),
      ingestPath: String(config.ingestPath || config.ingest_path || "ingest/requests"),
      environment: String(config.environment || "production"),
      batchSize: Math.max(toNonNegativeInt(config.batchSize, 200), 1),
      flushIntervalMs: Math.max(toNonNegativeInt(config.flushIntervalMs, 3000), 50),
      timeoutMs: Math.max(toNonNegativeInt(config.timeoutMs, 5000), 1),
      maxQueueSize: Math.max(toNonNegativeInt(config.maxQueueSize, 10_000), 1),
      maxRetries: Math.max(toNonNegativeInt(config.maxRetries, 3), 0),
      retryBackoffBaseMs: Math.max(
        toNonNegativeInt(config.retryBackoffBaseMs, 250),
        1,
      ),
      retryBackoffMaxMs: Math.max(
        toNonNegativeInt(config.retryBackoffMaxMs, 5000),
        1,
      ),
      enabled: config.enabled !== false,
      userAgent: String(config.userAgent || `apilens-js-sdk/${SDK_VERSION}`),
      fetchImpl: resolveFetch(config.fetchImpl),
      logger: config.logger || console,
    };

    if (!isNonEmptyString(this.config.apiKey)) {
      throw new Error("apiKey is required");
    }

    this.queue = [];
    this.droppedCount = 0;

    ApiLensClient.instance = this;

    if (this.config.enabled) {
      this.start();
    }
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public start(): void {
    if (this.flushIntervalId || !this.isEnabled()) {
      return;
    }

    this.flushIntervalId = setInterval(() => {
      void this.flushOnce();
    }, this.config.flushIntervalMs);

    if (typeof this.flushIntervalId.unref === "function") {
      this.flushIntervalId.unref();
    }
  }

  public stop(): void {
    if (!this.flushIntervalId) {
      return;
    }

    clearInterval(this.flushIntervalId);
    this.flushIntervalId = undefined;
  }

  public capture(payload: ApiLensRecordInput): void {
    this.captureRecord(normalizeRecord(payload, this.config.environment));
  }

  public captureRecord(record: ApiLensRecord): void {
    if (!this.isEnabled()) {
      return;
    }

    if (this.queue.length >= this.config.maxQueueSize) {
      this.queue.shift();
      this.droppedCount += 1;
    }

    this.queue.push(record);

    if (this.queue.length >= this.config.batchSize) {
      void this.flushOnce();
    }
  }

  public captureMany(records: ApiLensRecordInput[]): void {
    const items = Array.isArray(records) ? records : [];
    for (const record of items) {
      this.captureRecord(normalizeRecord(record, this.config.environment));
    }
  }

  public async flushOnce(): Promise<number> {
    if (!this.queue.length) {
      return 0;
    }

    const batch = this.queue.splice(0, this.config.batchSize);
    const sent = await this.sendBatchWithRetry(batch);

    if (!sent) {
      this.config.logger.warn?.(
        `API Lens ingest failed; dropping batch of ${batch.length} records`,
      );
      return 0;
    }

    return batch.length;
  }

  public async flushAll(): Promise<number> {
    let total = 0;
    while (this.queue.length > 0) {
      const sent = await this.flushOnce();
      if (sent <= 0) {
        break;
      }
      total += sent;
    }
    return total;
  }

  public async handleShutdown({ flush = true }: { flush?: boolean } = {}): Promise<void> {
    this.config.enabled = false;
    this.stop();

    if (flush) {
      await this.flushAll();
    }

    ApiLensClient.instance = undefined;
  }

  private async sendBatchWithRetry(batch: ApiLensRecord[]): Promise<boolean> {
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        await this.sendBatch(batch);
        return true;
      } catch (error) {
        if (attempt >= this.config.maxRetries) {
          this.config.logger.warn?.(
            "API Lens ingest request failed after retries",
            error,
          );
          return false;
        }

        const backoffMs = Math.min(
          this.config.retryBackoffBaseMs * (2 ** attempt),
          this.config.retryBackoffMaxMs,
        );
        await sleep(backoffMs);
      }
    }

    return false;
  }

  private async sendBatch(batch: ApiLensRecord[]): Promise<void> {
    const rawIngestPath = String(this.config.ingestPath || "ingest/requests").trim();
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");

    let endpoint: string;
    if (/^https?:\/\//i.test(rawIngestPath)) {
      endpoint = rawIngestPath;
    } else if (rawIngestPath.startsWith("/")) {
      // Backward-compatible behavior: explicit leading slash means host-root path.
      const origin = new URL(`${baseUrl}/`).origin;
      endpoint = new URL(rawIngestPath, origin).toString();
    } else {
      // Relative path appends to base path (e.g. /api/v1 + ingest/requests).
      endpoint = new URL(rawIngestPath, `${baseUrl}/`).toString();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    if (typeof timeout.unref === "function") {
      timeout.unref();
    }

    try {
      const response = await this.config.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.config.apiKey,
          "User-Agent": this.config.userAgent,
        },
        body: JSON.stringify({ requests: batch }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ingest request failed with status ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export { ApiLensClient, normalizeRecord };
