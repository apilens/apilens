/**
 * The framework-neutral capture core shared by the Express, Fastify and
 * NestJS adapters.
 *
 * `CaptureCore` holds everything resolved once per middleware/plugin (client,
 * redaction, exclusions, sampling, tracing). `CaptureCore.begin()` starts a
 * `RequestCapture` for one request; the adapter feeds it the response bytes
 * (`addResponseChunk`) and, once the response is sent, what only the
 * framework knows (`finish`: status, response headers, route template,
 * consumer, parsed request body, error). Everything else — the record,
 * masking, sampling, spans and the error log — is done here, identically for
 * every framework.
 */
import type { IncomingHttpHeaders } from "node:http";
import { performance } from "node:perf_hooks";

import { ApiLensClient } from "./client.js";
import { resolveConfig } from "./env.js";
import { RequestExcluder } from "./exclusions.js";
import { effectiveConfig } from "./metadata.js";
import { Sampler } from "./sampling.js";
import {
  RequestSpans,
  SpanRecorder,
  envSpansEnabled,
  errorLogContent,
  instrumentOutboundHttp,
} from "./spans.js";
import { beginRequestTrace, runWithTrace, type TraceContext } from "./trace.js";
import { parametrizeEnabled, resolveEndpointPath } from "./routes.js";
import {
  ContentTypeFilter,
  FORM_CONTENT_TYPE,
  Redactor,
  captureBody,
  lowerHeaders,
  mediaType,
  serializeHeaders,
} from "./sanitize.js";
import type { HeaderMap, RequestBodyInfo, ResponseBodyInfo } from "./sanitize.js";
import {
  firstForwardedIp,
  payloadToString,
  toNonNegativeInt,
  toNumber,
} from "./utils.js";
import type { ApiLensConsumer, ApiLensExpressConfig } from "./types.js";

type ConsumerFields = { consumer_id: string; consumer_name: string; consumer_group: string };

export function consumerFromStringOrObject(
  value: ApiLensConsumer | string | null | undefined,
): ConsumerFields | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return {
      consumer_id: value,
      consumer_name: "",
      consumer_group: "",
    };
  }

  return {
    consumer_id: String(value.id || value.identifier || value.consumer_id || ""),
    consumer_name: String(value.name || value.consumer_name || ""),
    consumer_group: String(value.group || value.consumer_group || ""),
  };
}

export function headerString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

/**
 * The captured request body as bytes, at most `maxBytes`. Frameworks hand the
 * body over already parsed: a parsed form (`express.urlencoded`,
 * `@fastify/formbody`) is re-encoded as a form so it is masked field by
 * field; other objects are serialized as JSON.
 */
export function requestBodyBytes(body: unknown, contentType: string, maxBytes: number): Buffer {
  if (body === undefined || body === null || maxBytes <= 0) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body.subarray(0, maxBytes);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8").subarray(0, maxBytes);
  }
  if (
    mediaType(contentType) === FORM_CONTENT_TYPE &&
    typeof body === "object" &&
    !Array.isArray(body)
  ) {
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        form.append(name, typeof v === "string" ? v : JSON.stringify(v) ?? "");
      }
    }
    return Buffer.from(form.toString(), "utf8").subarray(0, maxBytes);
  }
  return Buffer.from(payloadToString(body, maxBytes), "utf8");
}

/** The error that reached an adapter's error hook, by (raw Node) request. */
const requestErrors = new WeakMap<object, unknown>();

/** Remember `err` as the error of `req`, for the error log of a 5xx. */
export function recordRequestError(req: object, err: unknown): void {
  requestErrors.set(req, err);
}

/** The error recorded for `req`, if any. */
export function requestError(req: object): unknown {
  return requestErrors.get(req);
}

export function buildClient(config: ApiLensExpressConfig = {}): ApiLensClient {
  if (config.client instanceof ApiLensClient) {
    return config.client;
  }

  return new ApiLensClient({
    apiKey: config.apiKey || config.api_key || config.clientId || config.client_id,
    projectSlug: config.projectSlug || config.project_slug,
    appId: config.appId || config.app_id,
    baseUrl: config.baseUrl || config.base_url,
    ingestPath: config.ingestPath || config.ingest_path,
    environment: config.environment || config.env,
    release: config.release,
    commit: config.commit,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    timeoutMs: config.timeoutMs,
    maxQueueSize: config.maxQueueSize,
    maxQueueBytes: config.maxQueueBytes,
    maxBatchBytes: config.maxBatchBytes,
    compress: config.compress,
    onStats: config.onStats,
    maxRetries: config.maxRetries,
    retryBackoffBaseMs: config.retryBackoffBaseMs,
    retryBackoffMaxMs: config.retryBackoffMaxMs,
    enabled: config.enabled,
    userAgent: config.userAgent,
    fetchImpl: config.fetchImpl,
    logger: config.logger,
    sendHeartbeat: config.sendHeartbeat,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatPath: config.heartbeatPath,
    sendMetadata: config.sendMetadata,
    metadataPath: config.metadataPath,
  });
}

/** What the adapter knows about a request when it arrives. */
export type CaptureRequestStart = {
  method: string;
  /** The URL as received: path plus query string. */
  url: string;
  headers: IncomingHttpHeaders;
  /** The framework's client IP (after its proxy handling), else the socket address. */
  ip?: string;
};

/** What the adapter knows once the response has been sent. */
export type CaptureRequestFinish = {
  statusCode: number;
  responseHeaders: HeaderMap;
  /** The matched route template (`{name}` params), undefined when none matched. */
  routeTemplate?: string;
  /** Consumer set on the request by the app (`setConsumer`). */
  consumer?: ApiLensConsumer | string | null;
  /** Arguments for the `getConsumer` option when `consumer` is unset. */
  consumerArgs: [unknown, unknown];
  /** The parsed request body. */
  requestBody: unknown;
  /** The error that failed the request, for the error log of a 5xx. */
  error?: unknown;
};

/** One request in flight; see `CaptureCore.begin`. */
export class RequestCapture {
  readonly trace?: TraceContext;
  readonly rawPath: string;

  private readonly startedAt = performance.now();
  private readonly startedAtDate = new Date();
  private readonly requestSpans?: RequestSpans;
  private readonly method: string;
  private readonly url: string;
  private readonly queryAt: number;
  private readonly headers: IncomingHttpHeaders;
  private readonly requestSize: number;
  private readonly ipAddress: string;
  private readonly userAgent: string;
  private sampled: boolean;
  private readonly responseChunks: Buffer[] = [];
  private responseSize = 0;
  private bufferedSize = 0;
  // Decided on the first body chunk, once the handler has set Content-Type.
  private bufferResponse: boolean | undefined;
  private finished = false;

  constructor(private readonly core: CaptureCore, start: CaptureRequestStart) {
    const headers = start.headers;
    this.headers = headers;
    // Continues an incoming `traceparent`, else starts a trace. Child spans
    // wait in `requestSpans` until the request is known to be sampled in.
    if (core.spanRecorder) {
      this.requestSpans = new RequestSpans(core.spanRecorder);
      this.trace = beginRequestTrace(headers.traceparent, this.requestSpans);
      this.requestSpans.bind(this.trace);
    }
    this.method = String(start.method || "GET").toUpperCase();
    this.requestSize = toNonNegativeInt(headers["content-length"], 0);
    this.ipAddress =
      firstForwardedIp(headers["x-forwarded-for"]) ||
      String(headers["x-real-ip"] || start.ip || "");
    this.userAgent = String(headers["user-agent"] || "");
    this.url = String(start.url || "/");
    this.queryAt = this.url.indexOf("?");
    this.rawPath = this.queryAt === -1 ? this.url : this.url.slice(0, this.queryAt);

    // Decided before any response body is buffered. Sampled-out requests are
    // still recorded (base fields only), so metrics are unaffected.
    this.sampled = core.sampler.decideRequest(() => ({
      method: this.method,
      path: this.rawPath,
      query: this.query(),
      userAgent: this.userAgent,
      headers,
      clientIp: this.ipAddress,
    }));
  }

  private query(): string {
    return this.queryAt === -1 ? "" : this.url.slice(this.queryAt + 1);
  }

  /** Run `fn` (the rest of the request) inside this request's trace. */
  run<T>(fn: () => T): T {
    return this.trace ? runWithTrace(this.trace, fn) : fn();
  }

  /**
   * Count a response body chunk and buffer it (up to `maxPayloadBytes`) when
   * the request is sampled in and the response's content type is captured.
   */
  addResponseChunk(chunk: unknown, encoding: unknown, contentType: () => unknown): void {
    if (!chunk) {
      return;
    }
    const core = this.core;
    const normalizedEncoding =
      typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : undefined;
    const isBuffer = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array;
    if (!isBuffer && typeof chunk !== "string") {
      return;
    }
    const byteLen = isBuffer
      ? (chunk as Uint8Array).byteLength
      : Buffer.byteLength(chunk as string, normalizedEncoding);
    this.responseSize += byteLen;

    if (
      this.sampled &&
      core.capturePayloads &&
      core.logResponseBody &&
      core.maxPayloadBytes > 0 &&
      this.bufferedSize < core.maxPayloadBytes &&
      this.responseCapturable(contentType)
    ) {
      const raw = Buffer.isBuffer(chunk)
        ? chunk
        : isBuffer
          ? Buffer.from(chunk as Uint8Array)
          : Buffer.from(chunk as string, normalizedEncoding);
      const room = core.maxPayloadBytes - this.bufferedSize;
      const part = raw.subarray(0, room);
      this.responseChunks.push(part);
      this.bufferedSize += part.length;
    }
  }

  private responseCapturable(contentType: () => unknown): boolean {
    if (this.bufferResponse === undefined) {
      this.bufferResponse = this.core.contentTypes.allows(headerString(contentType()));
    }
    return this.bufferResponse;
  }

  /** Record the request (once). Never throws. */
  finish(out: CaptureRequestFinish): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const core = this.core;
    const { client, config, environment, redactor, contentTypes } = core;
    const method = this.method;
    const rawPath = this.rawPath;
    try {
      const responseTimeMs = Math.max(performance.now() - this.startedAt, 0);
      // Endpoint grouping path: matched route template, else id-looking
      // segments parametrized. raw_path keeps the exact URL with the query
      // string, matching query-param values redacted.
      const path = resolveEndpointPath(out.routeTemplate, rawPath || "/", core.parametrizePaths);
      const query = this.query();
      const rawPathWithQuery = query ? `${rawPath}?${redactor.redactQuery(query)}` : rawPath;
      const consumer =
        consumerFromStringOrObject(out.consumer) ||
        consumerFromStringOrObject(config.getConsumer?.(...out.consumerArgs));
      const statusCode = out.statusCode;
      const responseHeaders = out.responseHeaders;

      this.sampled = core.sampler.decideResponse(this.sampled, () => ({
        method,
        route: path,
        rawPath,
        statusCode,
        responseTimeMs,
        consumerId: consumer?.consumer_id || "",
        consumerName: consumer?.consumer_name || "",
        consumerGroup: consumer?.consumer_group || "",
        sampled: this.sampled,
      }));
      const sampled = this.sampled;

      const contentLength = toNumber(responseHeaders["content-length"], 0);
      const finalResponseSize = contentLength > 0 ? contentLength : this.responseSize;

      // Masked here, before capture(): raw values never reach the queue.
      // The user mask callbacks run first, then the regex field masking.
      // A sampled-out request sends only the base record: no headers or bodies.
      const capturing = sampled && core.capturePayloads;
      const requestContentType = headerString(this.headers["content-type"]);
      let requestInfo: RequestBodyInfo | undefined;
      const getRequestInfo = (): RequestBodyInfo => {
        requestInfo ??= {
          method,
          path: rawPath,
          rawPath: rawPathWithQuery,
          headers: lowerHeaders(this.headers),
          contentType: requestContentType,
        };
        return requestInfo;
      };
      const requestPayload =
        capturing && core.logRequestBody
          ? captureBody(requestBodyBytes(out.requestBody, requestContentType, core.maxPayloadBytes), {
              size: this.requestSize,
              contentType: requestContentType,
              contentTypes,
              redactor,
              masker: config.maskRequestBody,
              info: config.maskRequestBody ? getRequestInfo() : undefined,
            })
          : "";
      let responsePayload = "";
      if (capturing && core.logResponseBody) {
        const responseContentType = headerString(responseHeaders["content-type"]);
        const responseInfo: ResponseBodyInfo | undefined = config.maskResponseBody
          ? {
              request: getRequestInfo(),
              statusCode,
              headers: lowerHeaders(responseHeaders),
              contentType: responseContentType,
            }
          : undefined;
        responsePayload = captureBody(Buffer.concat(this.responseChunks), {
          size: Math.max(finalResponseSize, 0),
          contentType: responseContentType,
          contentTypes,
          redactor,
          masker: config.maskResponseBody,
          info: responseInfo,
        });
      }

      const trace = this.trace;
      const kept = client.capture({
        timestamp: new Date(),
        environment,
        project_slug: client.config.projectSlug,
        app_id: client.config.appId,
        method,
        path,
        raw_path: rawPathWithQuery,
        status_code: statusCode,
        response_time_ms: responseTimeMs,
        request_size: this.requestSize,
        response_size: Math.max(finalResponseSize, 0),
        ip_address: this.ipAddress,
        user_agent: this.userAgent,
        consumer_id: consumer?.consumer_id || "",
        consumer_name: consumer?.consumer_name || "",
        consumer_group: consumer?.consumer_group || "",
        request_payload: requestPayload,
        response_payload: responsePayload,
        request_headers:
          sampled && core.captureHeaders ? serializeHeaders(this.headers, { redactor }) : "",
        response_headers:
          sampled && core.captureHeaders
            ? serializeHeaders(responseHeaders, { redactor })
            : "",
        trace_id: trace?.traceId,
        span_id: trace?.spanId,
        sampled,
      });

      // Spans and the error log are detail: only for a sampled-in request.
      const spanRecorder = core.spanRecorder;
      if (spanRecorder && this.requestSpans && trace) {
        this.requestSpans.finish(kept);
        if (kept) {
          spanRecorder.span(trace, {
            spanId: trace.spanId,
            parentSpanId: trace.parentSpanId,
            name: `${method} ${path}`,
            kind: "server",
            startedAt: this.startedAtDate,
            durationMs: responseTimeMs,
            status: statusCode >= 500 ? "error" : "ok",
            statusCode,
            attributes: {
              "http.method": method,
              "http.route": path,
              "http.status_code": String(statusCode),
            },
          });
          if (statusCode >= 500) {
            spanRecorder.errorLog(trace, {
              ...errorLogContent(out.error, statusCode, method, path),
              method,
              path,
              statusCode,
              consumerId: consumer?.consumer_id || "",
              consumerName: consumer?.consumer_name || "",
              consumerGroup: consumer?.consumer_group || "",
            });
          }
        }
      }
    } catch (error) {
      client.config.logger.error?.("Error while logging request in API Lens middleware", error);
    }
  }
}

/** Everything resolved once per middleware / plugin. */
export class CaptureCore {
  readonly config: ApiLensExpressConfig;
  readonly client: ApiLensClient;
  readonly environment: string | undefined;
  readonly enabled: boolean;
  readonly logRequestBody: boolean;
  readonly logResponseBody: boolean;
  readonly capturePayloads: boolean;
  readonly captureHeaders: boolean;
  readonly maxPayloadBytes: number;
  readonly excluder: RequestExcluder;
  readonly redactor: Redactor;
  readonly contentTypes: ContentTypeFilter;
  readonly sampler: Sampler;
  readonly parametrizePaths: boolean;
  readonly captureSpans: boolean;
  readonly spanRecorder?: SpanRecorder;
  /** The effective configuration for the app metadata report. */
  readonly metadataConfig: Record<string, unknown>;
  private metadataStarted = false;

  constructor(options: ApiLensExpressConfig = {}) {
    // Explicit option > APILENS_* env var > captureProfile preset > default.
    const config = resolveConfig(options);
    this.config = config;
    const client = buildClient(config);
    this.client = client;
    const environment = config.environment || config.env;
    this.environment = environment;
    const requestLogging = config.requestLogging || {};

    this.enabled = config.enabled !== false;
    this.logRequestBody = requestLogging.logRequestBody !== false;
    this.logResponseBody = requestLogging.logResponseBody !== false;
    this.capturePayloads = requestLogging.capturePayloads !== false;
    this.captureHeaders = requestLogging.captureHeaders !== false;
    this.maxPayloadBytes = Math.max(0, toNonNegativeInt(requestLogging.maxPayloadBytes, 8192));
    this.excluder = new RequestExcluder({
      excludePaths: config.excludePaths,
      excludeUserAgents: config.excludeUserAgents,
      defaultExclusions: config.defaultExclusions,
    });
    // Compiled once per middleware; built-in DEFAULT_MASK_* patterns always apply.
    this.redactor = new Redactor({
      queryParams: config.redactQueryParams,
      headers: config.redactHeaders,
      bodyFields: config.redactBodyFields,
    });
    // Bodies of other media types (multipart, binary) are never buffered and
    // are stored as an "[<type>, N bytes omitted]" placeholder.
    this.contentTypes = new ContentTypeFilter(config.captureContentTypes);
    // Validated here: an out-of-range sampleRate throws at startup.
    this.sampler = new Sampler({
      sampleRate: config.sampleRate,
      sampleOnRequest: config.sampleOnRequest,
      sampleOnResponse: config.sampleOnResponse,
      logger: client.config.logger,
    });
    // Heuristic fallback for unmatched routes; APILENS_PARAMETRIZE_PATHS=false
    // overrides it. Matched framework routes are always used.
    this.parametrizePaths = config.parametrizePaths !== false;
    // Trace ids, request + outbound spans and the error log. Spans need an app
    // id; APILENS_CAPTURE_SPANS=false wins over code.
    this.captureSpans =
      this.enabled &&
      config.captureSpans !== false &&
      envSpansEnabled() &&
      Boolean(client.config.appId);
    if (this.captureSpans) {
      this.spanRecorder = new SpanRecorder(
        client,
        client.config.appId,
        environment || client.config.environment,
        String(config.serviceName || "").trim() || client.config.appId,
      );
      instrumentOutboundHttp();
    }

    // Heartbeats for this app and environment.
    client.registerApp(client.config.appId, environment);
    this.metadataConfig = effectiveConfig(client, {
      captureHeaders: this.captureHeaders,
      captureRequestBody: this.capturePayloads && this.logRequestBody,
      captureResponseBody: this.capturePayloads && this.logResponseBody,
      maxPayloadBytes: this.maxPayloadBytes,
      redactor: this.redactor,
      excluder: this.excluder,
      defaultExclusions: config.defaultExclusions !== false,
      sampleRate: this.sampler.sampleRate,
      callbacks: {
        sample_on_request: typeof config.sampleOnRequest === "function",
        sample_on_response: typeof config.sampleOnResponse === "function",
        get_consumer: typeof config.getConsumer === "function",
        mask_request_body: typeof config.maskRequestBody === "function",
        mask_response_body: typeof config.maskResponseBody === "function",
      },
    });
  }

  /** Whether the app metadata report has been scheduled. */
  get metadataReported(): boolean {
    return this.metadataStarted;
  }

  /** Schedule the app metadata report, once per core (the client dedupes per process). */
  reportMetadata(build: () => Record<string, unknown>): void {
    if (!this.enabled || this.metadataStarted) {
      return;
    }
    this.metadataStarted = true;
    this.client.reportMetadata(build, {
      environment: this.environment || this.client.config.environment,
    });
  }

  /** The `parametrize` argument for framework route-template helpers. */
  parametrizeTemplates(): boolean {
    return this.parametrizePaths && parametrizeEnabled();
  }

  /**
   * Start capturing a request, or undefined when it is not captured: capture
   * disabled (in code or by the remote policy; heartbeats continue), an
   * OPTIONS request, or an excluded path / user agent (health checks,
   * probes), which bypass capture entirely.
   */
  begin(start: CaptureRequestStart): RequestCapture | undefined {
    if (!this.enabled || !this.client.isCapturing() || start.method.toUpperCase() === "OPTIONS") {
      return undefined;
    }
    if (this.excluder.shouldExclude(start.url, start.headers["user-agent"] as string | undefined)) {
      return undefined;
    }
    return new RequestCapture(this, start);
  }
}
