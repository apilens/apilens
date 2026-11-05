import { promisify } from "node:util";
import { gzip } from "node:zlib";

import {
  isNonEmptyString,
  normalizePath,
  sleep,
  toISO8601,
  toNonNegativeInt,
  toNumber,
} from "./utils.js";
import { detectCommit, detectRelease } from "./release.js";
import { resolveConfig } from "./env.js";
import type {
  ApiLensClientConfig,
  ApiLensClientStats,
  ApiLensDropReason,
  ApiLensRecord,
  ApiLensRecordInput,
  Logger,
} from "./types.js";

const SDK_VERSION = "0.1.0";

const gzipAsync = promisify(gzip);

// Drop reasons reported by `ApiLensClient.dropCounts()` and `stats()`.
const DROP_QUEUE_FULL = "queue_full"; // record-count cap (maxQueueSize) hit
const DROP_QUEUE_BYTES = "queue_bytes"; // memory cap (maxQueueBytes) hit
const DROP_NON_RETRYABLE = "non_retryable"; // ingest rejected the batch with a 4xx
const DROP_RETRIES_EXHAUSTED = "retries_exhausted"; // still failing after maxRetries
// Not a drop: an oversized record was shortened (payloads first) to fit
// maxBatchBytes and still sent. Excluded from `droppedCount`.
const DROP_TRUNCATED = "truncated";
const DROP_REASONS: readonly ApiLensDropReason[] = [
  DROP_QUEUE_FULL,
  DROP_QUEUE_BYTES,
  DROP_NON_RETRYABLE,
  DROP_RETRIES_EXHAUSTED,
  DROP_TRUNCATED,
];

/**
 * Fixed per-record overhead added to the variable-length string fields when
 * estimating a queued record's size (object header, scalars, short fields).
 */
const RECORD_OVERHEAD_BYTES = 512;
const RETRY_AFTER_MAX_MS = 60_000;
const NON_RETRYABLE_LOG_INTERVAL_MS = 5 * 60_000;
const DROP_LOG_INTERVAL_MS = 60_000;
const MIN_BATCH_BYTES = 1024;
const GZIP_LEVEL = 5;
const TROUBLESHOOTING_URL = "https://apilens.ai/docs/support/troubleshooting";

const BATCH_PREFIX = '{"requests":[';
const BATCH_SUFFIX = "]}";
const BATCH_WRAPPER_BYTES = BATCH_PREFIX.length + BATCH_SUFFIX.length;

// Fields shortened first when a single record exceeds maxBatchBytes.
const TRUNCATE_FIELDS: readonly string[] = [
  "response_payload",
  "request_payload",
  "response_headers",
  "request_headers",
];

type RequiredConfig = {
  apiKey: string;
  projectSlug: string;
  appId: string;
  baseUrl: string;
  ingestPath: string;
  environment: string;
  release: string;
  commit: string;
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
  maxQueueSize: number;
  maxQueueBytes: number;
  maxBatchBytes: number;
  compress: boolean;
  maxRetries: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  enabled: boolean;
  userAgent: string;
  fetchImpl: typeof fetch;
  logger: Logger;
  onStats?: (stats: ApiLensClientStats) => void;
};

type PreparedBatch = {
  count: number;
  body: string;
};

type EncodedBody = {
  body: string | Uint8Array<ArrayBuffer>;
  gzipped: boolean;
};

class IngestError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

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

/**
 * Serialised-size estimate of a queued record: its variable-length string
 * fields plus a fixed `RECORD_OVERHEAD_BYTES`. Cheap (no JSON encoding).
 */
function estimateRecordBytes(record: ApiLensRecord): number {
  return (
    RECORD_OVERHEAD_BYTES
    + String(record.request_payload || "").length
    + String(record.response_payload || "").length
    + String(record.request_headers || "").length
    + String(record.response_headers || "").length
    + String(record.path || "").length
    + String(record.raw_path || "").length
    + String(record.user_agent || "").length
  );
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP date) into a delay in
 * milliseconds, capped at 60 s. Undefined when absent or invalid.
 */
function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return undefined;
  }

  let delayMs: number;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    delayMs = Number(raw) * 1000;
  } else {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) {
      return undefined;
    }
    delayMs = at - nowMs;
  }

  return Math.min(Math.max(delayMs, 0), RETRY_AFTER_MAX_MS);
}

/** 408, 429 and 5xx are worth retrying; any other 4xx cannot succeed. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Serialise `record`, shortening the payload fields (then headers, then any
 * other long string) until its JSON fits in `limit` bytes. Undefined when it
 * cannot be made to fit.
 */
function truncateRecordJson(record: ApiLensRecord, limit: number): string | undefined {
  const copy: Record<string, unknown> = { ...record };
  let json = JSON.stringify(copy);
  let bytes = Buffer.byteLength(json);

  const otherFields = Object.keys(copy)
    .filter((key) => typeof copy[key] === "string" && !TRUNCATE_FIELDS.includes(key))
    .sort((a, b) => String(copy[b]).length - String(copy[a]).length);

  for (const field of [...TRUNCATE_FIELDS, ...otherFields]) {
    while (bytes > limit) {
      const value = String(copy[field] ?? "");
      if (!value) {
        break;
      }
      const excess = bytes - limit;
      const nextLength = Math.max(Math.min(value.length - excess, value.length - 1), 0);
      copy[field] = value.slice(0, nextLength);
      json = JSON.stringify(copy);
      bytes = Buffer.byteLength(json);
    }
    if (bytes <= limit) {
      return json;
    }
  }

  return bytes <= limit ? json : undefined;
}

function normalizeRecord(
  input: ApiLensRecordInput,
  defaultEnvironment: string,
  defaultProjectSlug: string,
  defaultAppId: string,
  defaultRelease = "",
  defaultCommit = "",
): ApiLensRecord {
  const payload = input || ({} as ApiLensRecordInput);
  // A sampled-out record keeps its base fields (it still counts in metrics)
  // but never carries detail, whatever the caller passed.
  const sampled = payload.sampled !== false;
  const detail = (value: string | undefined): string => (sampled ? String(value || "") : "");
  return {
    timestamp: toISO8601(payload.timestamp),
    environment: String(payload.environment || defaultEnvironment || "production"),
    project_slug: String(payload.project_slug || defaultProjectSlug || ""),
    app_id: String(payload.app_id || defaultAppId || ""),
    method: String(payload.method || "GET").toUpperCase(),
    path: normalizePath(payload.path || "/"),
    raw_path: normalizePath(payload.raw_path || payload.path || "/"),
    status_code: toNonNegativeInt(payload.status_code, 0),
    response_time_ms: Math.max(toNumber(payload.response_time_ms, 0), 0),
    request_size: toNonNegativeInt(payload.request_size, 0),
    response_size: toNonNegativeInt(payload.response_size, 0),
    ip_address: String(payload.ip_address || ""),
    user_agent: String(payload.user_agent || ""),
    consumer_id: String(payload.consumer_id || ""),
    consumer_name: String(payload.consumer_name || ""),
    consumer_group: String(payload.consumer_group || ""),
    request_payload: detail(payload.request_payload),
    response_payload: detail(payload.response_payload),
    request_headers: detail(payload.request_headers),
    response_headers: detail(payload.response_headers),
    release: String(payload.release || defaultRelease || ""),
    commit: String(payload.commit || defaultCommit || ""),
    sampled,
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
  /** Overridable in tests: the wait between retries and its jitter source. */
  public sleepFn: (ms: number) => Promise<void> = sleep;
  public randomFn: () => number = Math.random;
  private queueSizes: number[] = [];
  private queuedBytesTotal = 0;
  private drops = Object.fromEntries(
    DROP_REASONS.map((reason) => [reason, 0]),
  ) as Record<ApiLensDropReason, number>;
  private sentBatches = 0;
  private sentRecords = 0;
  private failedBatches = 0;
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;
  private nonRetryableLoggedAt = new Map<number, number>();
  private lastDropLogAt = 0;
  private lastLoggedDropped = 0;
  private flushIntervalId?: NodeJS.Timeout;

  constructor(config: ApiLensClientConfig = {}) {
    if (ApiLensClient.instance) {
      throw new Error("ApiLensClient is already initialized");
    }
    // Explicit option > APILENS_* env var > default.
    config = resolveConfig(config);

    this.config = {
      apiKey: String(config.apiKey || config.api_key || "").trim(),
      projectSlug: String(config.projectSlug || config.project_slug || "").trim(),
      appId: String(config.appId || config.app_id || "").trim(),
      baseUrl: String(
        config.baseUrl || config.base_url || "https://ingest.apilens.ai/v1",
      ),
      ingestPath: String(config.ingestPath || config.ingest_path || "requests"),
      environment: String(config.environment || "production"),
      release: String(config.release || "").trim() || detectRelease(),
      commit: String(config.commit || "").trim() || detectCommit(),
      batchSize: Math.max(toNonNegativeInt(config.batchSize, 200), 1),
      flushIntervalMs: Math.max(toNonNegativeInt(config.flushIntervalMs, 3000), 50),
      timeoutMs: Math.max(toNonNegativeInt(config.timeoutMs, 5000), 1),
      maxQueueSize: Math.max(toNonNegativeInt(config.maxQueueSize, 10_000), 1),
      maxQueueBytes: Math.max(
        toNonNegativeInt(config.maxQueueBytes, 64 * 1024 * 1024),
        1,
      ),
      maxBatchBytes: Math.max(
        toNonNegativeInt(config.maxBatchBytes, 4 * 1024 * 1024),
        MIN_BATCH_BYTES,
      ),
      compress: config.compress !== false,
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
      onStats: typeof config.onStats === "function" ? config.onStats : undefined,
    };

    if (!isNonEmptyString(this.config.apiKey)) {
      throw new Error("apiKey is required");
    }
    // projectSlug is optional: the API key is project-level, so the server
    // derives the project from the key. appId selects which app in the project.
    if (!isNonEmptyString(this.config.appId)) {
      throw new Error("appId is required");
    }

    this.queue = [];

    ApiLensClient.instance = this;

    if (this.config.enabled) {
      this.start();
    }
  }

  /** Total records dropped for any reason (truncated records were still sent). */
  public get droppedCount(): number {
    let total = 0;
    for (const reason of DROP_REASONS) {
      if (reason !== DROP_TRUNCATED) {
        total += this.drops[reason];
      }
    }
    return total;
  }

  /**
   * Records dropped so far, by reason: `queue_full`, `queue_bytes`,
   * `non_retryable`, `retries_exhausted`, plus `truncated` (shortened, sent).
   */
  public dropCounts(): Record<ApiLensDropReason, number> {
    return { ...this.drops };
  }

  /** Estimated bytes held by the queue (bounded by `maxQueueBytes`). */
  public get queuedBytes(): number {
    return this.queuedBytesTotal;
  }

  /** Point-in-time delivery health snapshot. */
  public stats(): ApiLensClientStats {
    return {
      queuedRecords: this.queue.length,
      queuedBytes: this.queuedBytesTotal,
      sentBatches: this.sentBatches,
      sentRecords: this.sentRecords,
      failedBatches: this.failedBatches,
      droppedCount: this.droppedCount,
      dropCounts: this.dropCounts(),
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
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
    this.captureRecord(
      normalizeRecord(
        payload,
        this.config.environment,
        this.config.projectSlug,
        this.config.appId,
      ),
    );
  }

  public captureRecord(record: ApiLensRecord): void {
    if (!this.isEnabled()) {
      return;
    }

    // Records carry release/commit themselves so a batch can straddle a
    // deploy; fill them in here too for callers that build records directly.
    this.stampRelease(record);

    const size = estimateRecordBytes(record);
    const maxBytes = this.config.maxQueueBytes;
    if (size > maxBytes) {
      // A single record over the whole budget would evict everything and
      // still not fit: shed it instead.
      this.drops[DROP_QUEUE_BYTES] += 1;
      return;
    }

    if (this.queue.length >= this.config.maxQueueSize) {
      this.shiftQueue();
      this.drops[DROP_QUEUE_FULL] += 1;
    }

    while (this.queue.length > 0 && this.queuedBytesTotal + size > maxBytes) {
      this.shiftQueue();
      this.drops[DROP_QUEUE_BYTES] += 1;
    }

    this.queue.push(record);
    this.queueSizes.push(size);
    this.queuedBytesTotal += size;

    if (this.queue.length >= this.config.batchSize) {
      void this.flushOnce();
    }
  }

  private shiftQueue(): ApiLensRecord | undefined {
    const record = this.queue.shift();
    const size = this.queueSizes.shift() ?? 0;
    this.queuedBytesTotal = Math.max(this.queuedBytesTotal - size, 0);
    return record;
  }

  private stampRelease(record: ApiLensRecord): void {
    if (!record.release) {
      record.release = this.config.release;
    }
    if (!record.commit) {
      record.commit = this.config.commit;
    }
  }

  public captureMany(records: ApiLensRecordInput[]): void {
    const items = Array.isArray(records) ? records : [];
    for (const record of items) {
      this.captureRecord(
        normalizeRecord(
          record,
          this.config.environment,
          this.config.projectSlug,
          this.config.appId,
          this.config.release,
          this.config.commit,
        ),
      );
    }
  }

  public async flushOnce(): Promise<number> {
    const batch = this.takeBatch();
    if (!batch.count) {
      this.emitStats();
      return 0;
    }

    const sent = await this.sendBatchWithRetry(batch);
    this.emitStats();

    if (!sent) {
      this.config.logger.warn?.(
        `API Lens ingest failed; dropping batch of ${batch.count} records`,
      );
      return 0;
    }

    return batch.count;
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

  /** Full-jitter exponential backoff: uniform in [0, min(base * 2^n, max)). */
  public backoffMs(attempt: number): number {
    const ceiling = Math.min(
      this.config.retryBackoffBaseMs * (2 ** attempt),
      this.config.retryBackoffMaxMs,
    );
    return Math.floor(this.randomFn() * ceiling);
  }

  /**
   * Cut the next batch off the queue: stop at `batchSize` records or when the
   * JSON body would exceed `maxBatchBytes`. A single record larger than the
   * limit is truncated (payloads first) rather than dropped.
   */
  private takeBatch(): PreparedBatch {
    const limit = this.config.maxBatchBytes - BATCH_WRAPPER_BYTES;
    const parts: string[] = [];
    let total = 0;

    while (this.queue.length > 0 && parts.length < this.config.batchSize) {
      const record = this.queue[0];
      let json = JSON.stringify(record);
      let bytes = Buffer.byteLength(json);
      const separator = parts.length > 0 ? 1 : 0;

      if (parts.length > 0 && total + separator + bytes > limit) {
        break;
      }

      this.shiftQueue();
      if (bytes > limit) {
        const truncated = truncateRecordJson(record, limit);
        if (truncated === undefined) {
          this.drops[DROP_QUEUE_BYTES] += 1;
          continue;
        }
        json = truncated;
        bytes = Buffer.byteLength(json);
        this.drops[DROP_TRUNCATED] += 1;
      }

      parts.push(json);
      total += separator + bytes;
    }

    return {
      count: parts.length,
      body: `${BATCH_PREFIX}${parts.join(",")}${BATCH_SUFFIX}`,
    };
  }

  private async sendBatchWithRetry(batch: PreparedBatch): Promise<boolean> {
    const payload = await this.encodeBody(batch.body);
    let reason: ApiLensDropReason = DROP_RETRIES_EXHAUSTED;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        await this.post(payload);
        this.sentBatches += 1;
        this.sentRecords += batch.count;
        this.lastSuccessAt = new Date().toISOString();
        return true;
      } catch (error) {
        lastError = error;
        if (error instanceof IngestError && !error.retryable) {
          reason = DROP_NON_RETRYABLE;
          this.logNonRetryable(error);
          break;
        }
        if (attempt >= this.config.maxRetries) {
          break;
        }
        const retryAfterMs = error instanceof IngestError ? error.retryAfterMs : undefined;
        await this.sleepFn(retryAfterMs ?? this.backoffMs(attempt));
      }
    }

    this.drops[reason] += batch.count;
    this.failedBatches += 1;
    this.lastError = lastError instanceof Error ? lastError.message : String(lastError);
    if (reason === DROP_RETRIES_EXHAUSTED) {
      this.config.logger.warn?.(
        "API Lens ingest request failed after retries",
        lastError,
      );
    }
    return false;
  }

  private async encodeBody(body: string): Promise<EncodedBody> {
    if (!this.config.compress) {
      return { body, gzipped: false };
    }
    try {
      // zlib's async API runs on the libuv threadpool, off the request path.
      const compressed = await gzipAsync(body, { level: GZIP_LEVEL });
      return { body: new Uint8Array(compressed), gzipped: true };
    } catch (error) {
      this.config.logger.debug?.("API Lens gzip failed; sending identity", error);
      return { body, gzipped: false };
    }
  }

  private logNonRetryable(error: IngestError): void {
    const status = error.status ?? 0;
    const now = Date.now();
    const last = this.nonRetryableLoggedAt.get(status);
    if (last !== undefined && now - last < NON_RETRYABLE_LOG_INTERVAL_MS) {
      return;
    }
    this.nonRetryableLoggedAt.set(status, now);

    if (status === 401) {
      this.config.logger.error?.(
        "API Lens rejected the API key (401 Unauthorized); records are being dropped. "
        + `Check apiKey / APILENS_API_KEY. See ${TROUBLESHOOTING_URL}`,
      );
      return;
    }
    this.config.logger.warn?.(
      `API Lens ingest rejected a batch with status ${status}; not retrying.`,
      error.responseBody || "",
    );
  }

  private emitStats(): void {
    const stats = this.stats();
    this.config.logger.debug?.(
      `API Lens stats: queued=${stats.queuedRecords} (${stats.queuedBytes} B) `
      + `sent=${stats.sentRecords} in ${stats.sentBatches} batches `
      + `failed=${stats.failedBatches} dropped=${stats.droppedCount}`,
    );

    const now = Date.now();
    if (
      stats.droppedCount > this.lastLoggedDropped
      && now - this.lastDropLogAt >= DROP_LOG_INTERVAL_MS
    ) {
      this.config.logger.info?.(
        `API Lens dropped ${stats.droppedCount - this.lastLoggedDropped} records `
        + `(total ${stats.droppedCount})`,
        stats.dropCounts,
      );
      this.lastDropLogAt = now;
      this.lastLoggedDropped = stats.droppedCount;
    }

    if (this.config.onStats) {
      try {
        this.config.onStats(stats);
      } catch (error) {
        this.config.logger.debug?.("API Lens onStats callback threw", error);
      }
    }
  }

  private resolveEndpoint(): string {
    const rawIngestPath = String(this.config.ingestPath || "requests").trim();
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");

    if (/^https?:\/\//i.test(rawIngestPath)) {
      return rawIngestPath;
    }
    if (rawIngestPath.startsWith("/")) {
      // Backward-compatible behavior: explicit leading slash means host-root path.
      const origin = new URL(`${baseUrl}/`).origin;
      return new URL(rawIngestPath, origin).toString();
    }
    // Relative path appends to base path (e.g. /v1 + requests).
    return new URL(rawIngestPath, `${baseUrl}/`).toString();
  }

  private async post(payload: EncodedBody): Promise<void> {
    const endpoint = this.resolveEndpoint();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    if (typeof timeout.unref === "function") {
      timeout.unref();
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": this.config.apiKey,
      "User-Agent": this.config.userAgent,
    };
    if (payload.gzipped) {
      headers["Content-Encoding"] = "gzip";
    }

    let response: Response;
    try {
      response = await this.config.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: payload.body,
        signal: controller.signal,
      });
    } catch (error) {
      // Network error or timeout (abort): retryable.
      throw new IngestError(
        `Ingest network error: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return;
    }

    const status = response.status;
    const retryable = isRetryableStatus(status);
    let responseBody = "";
    if (!retryable) {
      try {
        responseBody = (await response.text()).slice(0, 512);
      } catch {
        responseBody = "";
      }
    }
    throw new IngestError(
      `Ingest request failed with status ${status}`,
      retryable,
      status,
      retryable ? parseRetryAfter(response.headers?.get("retry-after")) : undefined,
      responseBody,
    );
  }
}

export {
  ApiLensClient,
  DROP_REASONS,
  RECORD_OVERHEAD_BYTES,
  estimateRecordBytes,
  normalizeRecord,
  parseRetryAfter,
};
