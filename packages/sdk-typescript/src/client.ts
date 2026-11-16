import { logAppChoice, resolveAppId } from "./app.js";
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
import { runWithoutTrace } from "./trace.js";
import { gzipText, processEnv, processObject, randomUUID, runtimeName } from "./runtime.js";
import {
  applyRemotePolicy,
  narrowPayloadBytes,
  parseRemotePolicy,
  type RemotePolicy,
} from "./policy.js";
import type {
  ApiLensClientConfig,
  ApiLensClientStats,
  ApiLensDropReason,
  ApiLensFlushMode,
  ApiLensLogRecord,
  ApiLensRecord,
  ApiLensRecordInput,
  ApiLensSpanRecord,
  Logger,
} from "./types.js";

const SDK_VERSION = "0.1.0";
/** `sdk_name` in heartbeats. */
const SDK_NAME = "apilens-js-sdk";

// Heartbeat (`POST /v1/heartbeat`, contract: apps/docs/ingest/heartbeat.mdx).
// Sent on start, every `heartbeatIntervalMs` and once more with `final: true`
// on shutdown. Ingest answers 429 to heartbeats of one instance less than
// 10 s apart, so shorter intervals are refused.
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_MIN_INTERVAL_MS = 10_000;
// App metadata (`POST /v1/metadata`): sent once per process start, this long
// after the middleware is installed so routes registered after it are in.
const METADATA_DELAY_MS = 1000;
// Env kill switches: `false`, `0`, `no` or `off` never send that report.
const ENV_SEND_HEARTBEAT = "APILENS_SEND_HEARTBEAT";
const ENV_SEND_METADATA = "APILENS_SEND_METADATA";

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

/** W3C ids: lower-case hex of the given length, else "". */
function hexId(value: unknown, length: number): string {
  const raw = String(value || "").trim().toLowerCase();
  return raw.length === length && /^[0-9a-f]+$/.test(raw) ? raw : "";
}

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
  tracesPath: string;
  logsPath: string;
  heartbeatPath: string;
  metadataPath: string;
  sendHeartbeat: boolean;
  heartbeatIntervalMs: number;
  sendMetadata: boolean;
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
  flushMode: ApiLensFlushMode;
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

function envFlagEnabled(name: string): boolean {
  const raw = processEnv()[name];
  if (raw === undefined) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** Mirror of the ingest edge's check: `api_key` / `apiKey` / `api-key`, any case. */
function isApiKeyName(name: string): boolean {
  return name.toLowerCase().replace(/[_\-. ]/g, "") === "apikey";
}

/**
 * Copy of `value` without object keys naming an API key, at any depth: the
 * ingest edge rejects a heartbeat or metadata body that has one.
 */
function stripApiKeyFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripApiKeyFields);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (!isApiKeyName(key)) {
        out[key] = stripApiKeyFields(child);
      }
    }
    return out;
  }
  return value;
}

/** Metadata reports already started in this process, by base URL, app and environment. */
const metadataReported = new Set<string>();

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
    trace_id: hexId(payload.trace_id, 32),
    span_id: hexId(payload.span_id, 16),
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
  /** Spans waiting for `POST /v1/traces` (bounded by `maxQueueSize`). */
  public spanQueue: ApiLensSpanRecord[] = [];
  /** Logs waiting for `POST /v1/logs` (bounded by `maxQueueSize`). */
  public logQueue: ApiLensLogRecord[] = [];
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
  /** Id of this process in heartbeats, new on every process start. */
  public readonly instanceId: string = randomUUID();
  private readonly startedAtMs = Date.now();
  /** Apps (and environments) heartbeats are sent for, by `appId\0environment`. */
  private heartbeatApps = new Map<string, { appId: string; environment: string }>();
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private heartbeatsRunning = false;
  private heartbeatsStarted = false;
  private heartbeatLogged = new Set<number>();
  private remotePolicyState: RemotePolicy | null = null;
  private metadataTimers = new Map<string, NodeJS.Timeout>();
  /** Inline flush mode: metadata reports waiting for the next `flushInline()`. */
  private pendingMetadata = new Map<string, () => Record<string, unknown> | null | undefined>();
  /** Inline flush mode: when the next heartbeat is due (epoch ms). */
  private nextInlineHeartbeatAt = 0;
  private metadataLogged = new Set<number>();

  constructor(config: ApiLensClientConfig = {}) {
    if (ApiLensClient.instance) {
      throw new Error("ApiLensClient is already initialized");
    }
    // Optional app name: code > APILENS_APP_ID > OTEL_SERVICE_NAME > "" (the
    // project's default app). Free-form; the server slugifies it.
    const app = resolveAppId(config.appId || config.app_id);
    // Explicit option > APILENS_* env var > default.
    config = resolveConfig(config);

    this.config = {
      apiKey: String(config.apiKey || config.api_key || "").trim(),
      projectSlug: String(config.projectSlug || config.project_slug || "").trim(),
      appId: app.appId,
      baseUrl: String(
        config.baseUrl || config.base_url || "https://ingest.apilens.ai/v1",
      ),
      ingestPath: String(config.ingestPath || config.ingest_path || "requests"),
      tracesPath: String(config.tracesPath || "traces"),
      logsPath: String(config.logsPath || "logs"),
      heartbeatPath: String(config.heartbeatPath || "heartbeat"),
      metadataPath: String(config.metadataPath || "metadata"),
      sendHeartbeat: config.sendHeartbeat !== false,
      heartbeatIntervalMs: toNumber(config.heartbeatIntervalMs, HEARTBEAT_INTERVAL_MS),
      sendMetadata: config.sendMetadata !== false,
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
      flushMode: config.flushMode === "inline" ? "inline" : "background",
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
    // derives the project from the key. appId (optional) selects which app.
    logAppChoice(this.config.logger, app.appId, app.source);
    if (!(this.config.heartbeatIntervalMs >= HEARTBEAT_MIN_INTERVAL_MS)) {
      throw new Error(
        `heartbeatIntervalMs must be >= ${HEARTBEAT_MIN_INTERVAL_MS} (ingest rate-limits faster heartbeats)`,
      );
    }

    this.queue = [];
    // An empty appId is the project's default app; its heartbeats carry app_id "".
    this.heartbeatApps.set(`${this.config.appId}\0${this.config.environment}`, {
      appId: this.config.appId,
      environment: this.config.environment,
    });

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

  /**
   * Whether requests are being captured: the client is enabled and the
   * remote capture policy has not turned capture off. Heartbeats continue
   * either way.
   */
  public isCapturing(): boolean {
    return this.config.enabled && this.remotePolicyState?.enabled !== false;
  }

  /**
   * The capture policy from the last successful heartbeat, or null before
   * the first one. A failed heartbeat keeps the previous policy.
   */
  public get remotePolicy(): RemotePolicy | null {
    return this.remotePolicyState ? { ...this.remotePolicyState } : null;
  }

  /** `localMaxBytes` narrowed by the remote policy's `max_payload_bytes`. */
  public payloadLimit(localMaxBytes: number): number {
    return narrowPayloadBytes(localMaxBytes, this.remotePolicyState);
  }

  public start(): void {
    // Inline mode runs no timers: flushInline() does this work per request.
    if (this.config.flushMode === "inline") {
      return;
    }
    if (this.isEnabled()) {
      this.startHeartbeats();
    }
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
    this.stopHeartbeats();
    if (!this.flushIntervalId) {
      return;
    }

    clearInterval(this.flushIntervalId);
    this.flushIntervalId = undefined;
  }

  /** Queue one request record; true when it was queued with its detail (sampled in). */
  public capture(payload: ApiLensRecordInput): boolean {
    return this.captureRecord(
      normalizeRecord(
        payload,
        this.config.environment,
        this.config.projectSlug,
        this.config.appId,
      ),
    );
  }

  /** Queue one request record; true when it was queued with its detail (sampled in). */
  public captureRecord(record: ApiLensRecord): boolean {
    if (!this.isEnabled()) {
      return false;
    }

    // Records carry release/commit themselves so a batch can straddle a
    // deploy; fill them in here too for callers that build records directly.
    this.stampRelease(record);

    // The remote policy only narrows: it can drop the record, sample it out
    // or strip detail, never add any back.
    if (this.remotePolicyState && !applyRemotePolicy(record, this.remotePolicyState, this.randomFn)) {
      return false;
    }

    const size = estimateRecordBytes(record);
    const maxBytes = this.config.maxQueueBytes;
    if (size > maxBytes) {
      // A single record over the whole budget would evict everything and
      // still not fit: shed it instead.
      this.drops[DROP_QUEUE_BYTES] += 1;
      return false;
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
    return record.sampled;
  }

  /** Queue one span for `POST /v1/traces` (dropped while not capturing). */
  public captureSpan(record: ApiLensSpanRecord): void {
    this.captureSignal(this.spanQueue, record);
  }

  /** Queue one log for `POST /v1/logs` (dropped while not capturing). */
  public captureLog(record: ApiLensLogRecord): void {
    this.captureSignal(this.logQueue, record);
  }

  private captureSignal<T extends { release: string; commit: string }>(queue: T[], record: T): void {
    if (!this.isCapturing()) {
      return;
    }
    if (!record.release) {
      record.release = this.config.release;
    }
    if (!record.commit) {
      record.commit = this.config.commit;
    }
    if (queue.length >= this.config.maxQueueSize) {
      queue.shift();
      this.drops[DROP_QUEUE_FULL] += 1;
    }
    queue.push(record);
    if (queue.length >= this.config.batchSize) {
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

  /**
   * Send the next batch of each queue (requests, spans, logs). Returns the
   * number of items delivered.
   */
  public async flushOnce(): Promise<number> {
    const batches: Array<{ batch: PreparedBatch; path?: string; label: string }> = [];
    const requests = this.takeBatch();
    if (requests.count) {
      batches.push({ batch: requests, label: "records" });
    }
    const spans = this.takeSignalBatch(this.spanQueue, "spans");
    if (spans.count) {
      batches.push({ batch: spans, path: this.config.tracesPath, label: "spans" });
    }
    const logs = this.takeSignalBatch(this.logQueue, "logs");
    if (logs.count) {
      batches.push({ batch: logs, path: this.config.logsPath, label: "logs" });
    }

    let total = 0;
    for (const { batch, path, label } of batches) {
      if (await this.sendBatchWithRetry(batch, path)) {
        total += batch.count;
      } else {
        this.config.logger.warn?.(
          `API Lens ingest failed; dropping batch of ${batch.count} ${label}`,
        );
      }
    }
    this.emitStats();
    return total;
  }

  public async flushAll(): Promise<number> {
    let total = 0;
    while (this.queue.length > 0 || this.spanQueue.length > 0 || this.logQueue.length > 0) {
      const sent = await this.flushOnce();
      if (sent <= 0) {
        break;
      }
      total += sent;
    }
    return total;
  }

  /**
   * Inline flush mode's per-request delivery (edge runtimes, where no timer
   * runs between requests): sends the pending metadata report, a heartbeat
   * when one is due, and everything queued. Never throws; returns the number
   * of items delivered. In background mode it only flushes the queues.
   */
  public async flushInline(): Promise<number> {
    if (!this.isEnabled()) {
      return 0;
    }
    const tasks: Array<Promise<unknown>> = [];
    for (const [key, build] of this.pendingMetadata) {
      this.pendingMetadata.delete(key);
      let payload: Record<string, unknown> | null | undefined;
      try {
        payload = build();
      } catch (error) {
        this.config.logger.debug?.("API Lens could not build the app metadata report", error);
        continue;
      }
      if (payload) {
        tasks.push(this.sendMetadata(payload));
      }
    }
    if (
      this.config.flushMode === "inline" &&
      this.heartbeatsEnabled() &&
      Date.now() >= this.nextInlineHeartbeatAt
    ) {
      this.heartbeatsStarted = true;
      // Not due again until this one has answered (concurrent requests).
      this.nextInlineHeartbeatAt = Number.POSITIVE_INFINITY;
      tasks.push(
        Promise.all([...this.heartbeatApps.keys()].map((key) => this.heartbeatOne(key))).then(
          (results) => {
            const nextMs = Math.max(this.config.heartbeatIntervalMs, ...results.map((r) => r.nextMs));
            this.nextInlineHeartbeatAt = Date.now() + nextMs;
          },
        ),
      );
    }
    let sent = 0;
    try {
      sent = await this.flushAll();
      await Promise.all(tasks);
    } catch (error) {
      this.config.logger.debug?.("API Lens inline flush failed", error);
    }
    return sent;
  }

  public async handleShutdown({ flush = true }: { flush?: boolean } = {}): Promise<void> {
    const sendFinal = this.heartbeatsStarted && this.heartbeatsEnabled();
    this.config.enabled = false;
    this.stop();
    for (const [key, timer] of this.metadataTimers) {
      clearTimeout(timer);
      metadataReported.delete(key);
    }
    this.metadataTimers.clear();
    for (const key of this.pendingMetadata.keys()) {
      metadataReported.delete(key);
    }
    this.pendingMetadata.clear();

    if (flush) {
      await this.flushAll();
    }
    if (sendFinal) {
      await this.sendHeartbeat({ final: true });
    }

    ApiLensClient.instance = undefined;
  }

  private heartbeatsEnabled(): boolean {
    return this.config.sendHeartbeat && envFlagEnabled(ENV_SEND_HEARTBEAT);
  }

  /**
   * Send heartbeats for `appId` in `environment` (default: the config's) from
   * now on. The client's own app is registered on construction; registering
   * the same app again does nothing.
   */
  public registerApp(appId: string, environment?: string): void {
    // "" is the project's default app (no app name configured).
    const app = String(appId || "").trim();
    const env = String(environment || this.config.environment);
    const key = `${app}\0${env}`;
    if (this.heartbeatApps.has(key)) {
      return;
    }
    this.heartbeatApps.set(key, { appId: app, environment: env });
    if (this.heartbeatsRunning) {
      this.scheduleHeartbeat(key, 0);
    }
  }

  /** The `POST /v1/heartbeat` body for one app. */
  public heartbeatPayload(
    appId: string = this.config.appId,
    environment: string = this.config.environment,
    { final = false }: { final?: boolean } = {},
  ): Record<string, unknown> {
    const stats = this.stats();
    const body: Record<string, unknown> = {
      app_id: appId,
      environment,
      instance_id: this.instanceId,
      sdk_name: SDK_NAME,
      sdk_version: SDK_VERSION,
      runtime: runtimeName(),
      // Left out (undefined) on a runtime without processes (edge).
      pid: processObject()?.pid,
      uptime_s: Math.max(Math.floor((Date.now() - this.startedAtMs) / 1000), 0),
      stats: {
        queued_records: stats.queuedRecords,
        queued_bytes: stats.queuedBytes,
        sent_batches: stats.sentBatches,
        sent_records: stats.sentRecords,
        failed_batches: stats.failedBatches,
        dropped: stats.droppedCount,
        drop_counts: stats.dropCounts,
        last_error: stats.lastError,
        last_success_at: stats.lastSuccessAt,
      },
    };
    if (this.config.projectSlug) {
      body.project_slug = this.config.projectSlug;
    }
    if (this.config.release) {
      body.release = this.config.release;
    }
    if (this.config.commit) {
      body.commit = this.config.commit;
    }
    if (final) {
      body.final = true;
    }
    return body;
  }

  /**
   * Send a heartbeat for every registered app now; true when all succeeded.
   * Never throws and never retries: a failure keeps the previous policy and
   * only waits for the next interval (or `Retry-After`).
   */
  public async sendHeartbeat({ final = false }: { final?: boolean } = {}): Promise<boolean> {
    if (!this.heartbeatsEnabled() || this.heartbeatApps.size === 0) {
      return false;
    }
    const results = await Promise.all(
      [...this.heartbeatApps.keys()].map(async (key) => {
        const { ok, nextMs } = await this.heartbeatOne(key, final);
        if (!final && this.heartbeatsRunning) {
          this.scheduleHeartbeat(key, nextMs);
        }
        return ok;
      }),
    );
    return results.every(Boolean);
  }

  private startHeartbeats(): void {
    if (this.heartbeatsRunning || !this.heartbeatsEnabled()) {
      return;
    }
    this.heartbeatsRunning = true;
    this.heartbeatsStarted = true;
    for (const key of this.heartbeatApps.keys()) {
      this.scheduleHeartbeat(key, 0);
    }
  }

  private stopHeartbeats(): void {
    this.heartbeatsRunning = false;
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer);
    }
    this.heartbeatTimers.clear();
  }

  private scheduleHeartbeat(key: string, delayMs: number): void {
    const existing = this.heartbeatTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.heartbeatTimers.delete(key);
    }
    if (!this.heartbeatsRunning) {
      return;
    }
    const timer = setTimeout(() => {
      this.heartbeatTimers.delete(key);
      void this.heartbeatOne(key).then(({ nextMs }) => {
        // Unless sendHeartbeat() rescheduled it meanwhile.
        if (this.heartbeatsRunning && !this.heartbeatTimers.has(key)) {
          this.scheduleHeartbeat(key, nextMs);
        }
      });
    }, delayMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.heartbeatTimers.set(key, timer);
  }

  private async heartbeatOne(key: string, final = false): Promise<{ ok: boolean; nextMs: number }> {
    const interval = this.config.heartbeatIntervalMs;
    const app = this.heartbeatApps.get(key);
    if (!app) {
      return { ok: false, nextMs: interval };
    }
    try {
      const body = stripApiKeyFields(this.heartbeatPayload(app.appId, app.environment, { final }));
      const response = await this.post(
        await this.encodeBody(JSON.stringify(body)),
        this.config.heartbeatPath,
      );
      this.applyHeartbeatResponse(await response.text());
      return { ok: true, nextMs: interval };
    } catch (error) {
      if (error instanceof IngestError) {
        this.logHeartbeatFailure(error);
        return { ok: false, nextMs: error.retryAfterMs ?? interval };
      }
      this.config.logger.debug?.("API Lens heartbeat failed", error);
      return { ok: false, nextMs: interval };
    }
  }

  private applyHeartbeatResponse(text: string): void {
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      this.config.logger.debug?.("API Lens heartbeat response is not JSON; keeping the previous policy");
      return;
    }
    const policy = parseRemotePolicy(data);
    if (!policy) {
      this.config.logger.debug?.("API Lens heartbeat response has no policy; keeping the previous policy");
      return;
    }
    this.remotePolicyState = policy;
  }

  private logHeartbeatFailure(error: IngestError): void {
    const status = error.status ?? 0;
    if (status === 401 || status === 403 || status === 422) {
      if (this.heartbeatLogged.has(status)) {
        return;
      }
      this.heartbeatLogged.add(status);
      this.config.logger.warn?.(
        `API Lens ingest rejected the heartbeat with status ${status}:`,
        error.responseBody || "<empty body>",
      );
      return;
    }
    this.config.logger.debug?.("API Lens heartbeat failed", error.message);
  }

  /**
   * Send the app metadata report once per process, without blocking: `build`
   * runs `delayMs` from now (so routes registered after the middleware are
   * in) and returns the `POST /v1/metadata` body. Returns false when a report
   * for this app and environment was already started in this process, or when
   * metadata is turned off (`sendMetadata: false`, `APILENS_SEND_METADATA=false`).
   */
  public reportMetadata(
    build: () => Record<string, unknown> | null | undefined,
    {
      appId = this.config.appId,
      environment = this.config.environment,
      delayMs = METADATA_DELAY_MS,
    }: { appId?: string; environment?: string; delayMs?: number } = {},
  ): boolean {
    if (!this.config.enabled || !this.config.sendMetadata || !envFlagEnabled(ENV_SEND_METADATA)) {
      return false;
    }
    const key = `${this.config.baseUrl}\0${appId}\0${environment}`;
    if (metadataReported.has(key)) {
      return false;
    }
    metadataReported.add(key);
    if (this.config.flushMode === "inline") {
      this.pendingMetadata.set(key, build);
      return true;
    }
    const timer = setTimeout(() => {
      this.metadataTimers.delete(key);
      let payload: Record<string, unknown> | null | undefined;
      try {
        payload = build();
      } catch (error) {
        this.config.logger.debug?.("API Lens could not build the app metadata report", error);
        return;
      }
      if (payload) {
        void this.sendMetadata(payload);
      }
    }, Math.max(delayMs, 0));
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.metadataTimers.set(key, timer);
    return true;
  }

  /**
   * POST one app metadata report now; true on 2xx. Retries 408/429/5xx and
   * network errors like a batch; never throws.
   */
  public async sendMetadata(payload: Record<string, unknown>): Promise<boolean> {
    let encoded: EncodedBody;
    try {
      encoded = await this.encodeBody(JSON.stringify(stripApiKeyFields(payload)));
    } catch (error) {
      this.config.logger.debug?.("API Lens could not encode the app metadata report", error);
      return false;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        await this.post(encoded, this.config.metadataPath);
        return true;
      } catch (error) {
        lastError = error;
        if (error instanceof IngestError && !error.retryable) {
          const status = error.status ?? 0;
          if (!this.metadataLogged.has(status)) {
            this.metadataLogged.add(status);
            this.config.logger.warn?.(
              `API Lens ingest rejected the app metadata report with status ${status}:`,
              error.responseBody || "<empty body>",
            );
          }
          return false;
        }
        if (attempt < this.config.maxRetries) {
          const retryAfterMs = error instanceof IngestError ? error.retryAfterMs : undefined;
          await this.sleepFn(retryAfterMs ?? this.backoffMs(attempt));
        }
      }
    }
    this.config.logger.debug?.("API Lens app metadata report failed", lastError);
    return false;
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

  /**
   * Cut the next `{"<key>": [...]}` batch off a span or log queue, by
   * `batchSize` and `maxBatchBytes`. An item larger than the limit is dropped.
   */
  private takeSignalBatch(queue: unknown[], key: string): PreparedBatch {
    const prefix = `{"${key}":[`;
    const limit = this.config.maxBatchBytes - prefix.length - BATCH_SUFFIX.length;
    const parts: string[] = [];
    let total = 0;

    while (queue.length > 0 && parts.length < this.config.batchSize) {
      const json = JSON.stringify(queue[0]);
      const bytes = Buffer.byteLength(json);
      const separator = parts.length > 0 ? 1 : 0;
      if (parts.length > 0 && total + separator + bytes > limit) {
        break;
      }
      queue.shift();
      if (bytes > limit) {
        this.drops[DROP_QUEUE_BYTES] += 1;
        continue;
      }
      parts.push(json);
      total += separator + bytes;
    }

    return { count: parts.length, body: `${prefix}${parts.join(",")}${BATCH_SUFFIX}` };
  }

  private async sendBatchWithRetry(batch: PreparedBatch, path?: string): Promise<boolean> {
    const payload = await this.encodeBody(batch.body);
    let reason: ApiLensDropReason = DROP_RETRIES_EXHAUSTED;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        await this.post(payload, path);
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
      // zlib (libuv threadpool, off the request path) or CompressionStream.
      return { body: await gzipText(body, GZIP_LEVEL), gzipped: true };
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

  private resolveEndpoint(path: string = this.config.ingestPath): string {
    const rawIngestPath = String(path || "requests").trim();
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

  private async post(payload: EncodedBody, path?: string): Promise<Response> {
    const endpoint = this.resolveEndpoint(path);
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
      // Outside any trace context: the SDK's own uploads are never traced.
      response = await runWithoutTrace(() => this.config.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: payload.body,
        signal: controller.signal,
      }));
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
      return response;
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
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  METADATA_DELAY_MS,
  SDK_NAME,
  SDK_VERSION,
  stripApiKeyFields,
  RECORD_OVERHEAD_BYTES,
  estimateRecordBytes,
  normalizeRecord,
  parseRetryAfter,
};
