/**
 * Span and error-log capture: what happened inside a request. Port of the
 * Python SDK's `apilens.client.spans`.
 *
 * Spans are automatic; there is no manual span API. The middleware records a
 * root `server` span per request, and outbound calls made with `http` /
 * `https` (`request`, `get`) or `fetch` / undici while handling it become
 * child `http` spans, with `traceparent` propagated downstream. `fetch` and
 * undici are observed through their `diagnostics_channel` events; `http` /
 * `https` are wrapped once per process.
 *
 * When a request fails (an unhandled error or a 5xx response) the
 * middleware also emits one ERROR log correlated to the trace, with the
 * stack when there was an error. That is the only thing sent to
 * `/v1/logs`; it is not a general logging API.
 *
 * `captureSpans: false` (or `APILENS_CAPTURE_SPANS=false`, which wins over
 * code) turns all of it off: no trace ids, no spans, no propagation, no
 * error log.
 */

import diagnosticsChannel from "node:diagnostics_channel";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

import type { ApiLensClient } from "./client.js";
import {
  currentTraceContext,
  formatTraceparent,
  generateSpanId,
  type ChildSpan,
  type SpanSink,
  type TraceContext,
} from "./trace.js";
import type { ApiLensLogRecord, ApiLensSpanRecord } from "./types.js";

export const ENV_CAPTURE_SPANS = "APILENS_CAPTURE_SPANS";

const MAX_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_VALUE_CHARS = 512;
const MAX_NAME_CHARS = 256;
const MAX_URL_CHARS = 512;
const MAX_LOG_MESSAGE_CHARS = 4000;
const MAX_LOG_PAYLOAD_CHARS = 8000;
/** Child spans held per request until it is known to be sampled in. */
export const MAX_PENDING_SPANS = 256;

/**
 * Process-wide kill switch: false when `APILENS_CAPTURE_SPANS` is set to
 * `0`/`false`/`no`/`off`. It only turns spans off; `captureSpans: true` in
 * code never overrides it.
 */
export function envSpansEnabled(): boolean {
  const raw = typeof process !== "undefined" ? process.env[ENV_CAPTURE_SPANS] : undefined;
  if (raw === undefined) {
    return true;
  }
  return !["0", "false", "no", "off", "disabled"].includes(raw.trim().toLowerCase());
}

/** String-valued attributes, at most 32, values cut to 512 characters. */
export function cleanAttributes(attributes: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) {
    return out;
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (Object.keys(out).length >= MAX_ATTRIBUTES) {
      break;
    }
    const name = String(key || "").trim();
    if (!name || (typeof value === "object" && value !== null)) {
      continue;
    }
    out[name] = String(value ?? "").slice(0, MAX_ATTRIBUTE_VALUE_CHARS);
  }
  return out;
}

/** URL without query string or userinfo: span names must not leak secrets. */
export function stripUrl(url: string): string {
  let text = String(url || "");
  const cut = text.search(/[?#]/);
  if (cut !== -1) {
    text = text.slice(0, cut);
  }
  const scheme = text.indexOf("://");
  if (scheme !== -1) {
    const rest = text.slice(scheme + 3);
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const at = authority.lastIndexOf("@");
    if (at !== -1) {
      text = text.slice(0, scheme + 3) + rest.slice(at + 1);
    }
  }
  return text.slice(0, MAX_URL_CHARS);
}

/** Where one middleware's spans and error logs go. */
export class SpanRecorder {
  constructor(
    readonly client: ApiLensClient,
    readonly appId: string,
    readonly environment: string,
    readonly serviceName: string,
  ) {}

  /** Queue one finished span of `ctx`'s trace. */
  span(
    ctx: TraceContext,
    span: {
      spanId: string;
      parentSpanId: string;
      name: string;
      kind: string;
      startedAt: Date;
      durationMs: number;
      status: "ok" | "error";
      statusCode: number;
      attributes?: Record<string, unknown>;
    },
  ): void {
    const record: ApiLensSpanRecord = {
      timestamp: span.startedAt.toISOString(),
      environment: this.environment,
      project_slug: this.client.config.projectSlug,
      app_id: this.appId,
      trace_id: ctx.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId,
      name: String(span.name || "").slice(0, MAX_NAME_CHARS),
      kind: String(span.kind || "internal").toLowerCase().slice(0, 16),
      service_name: this.serviceName,
      duration_ms: Math.max(Number(span.durationMs) || 0, 0),
      status: span.status === "error" ? "error" : "ok",
      status_code: Math.max(Math.trunc(Number(span.statusCode) || 0), 0),
      attributes: cleanAttributes(span.attributes),
      release: "",
      commit: "",
    };
    this.client.captureSpan(record);
  }

  /** Queue one ERROR log correlated to `ctx`'s request span. */
  errorLog(
    ctx: TraceContext,
    log: {
      message: string;
      payload: string;
      loggerName: string;
      method: string;
      path: string;
      statusCode: number;
      consumerId: string;
      consumerName: string;
      consumerGroup: string;
    },
  ): void {
    const record: ApiLensLogRecord = {
      timestamp: new Date().toISOString(),
      environment: this.environment,
      project_slug: this.client.config.projectSlug,
      app_id: this.appId,
      level: "ERROR",
      message: String(log.message || "").slice(0, MAX_LOG_MESSAGE_CHARS),
      logger_name: log.loggerName || "apilens",
      endpoint_method: String(log.method || "").toUpperCase(),
      endpoint_path: log.path || "",
      status_code: Math.max(Math.trunc(Number(log.statusCode) || 0), 0),
      consumer_id: log.consumerId || "",
      consumer_name: log.consumerName || "",
      consumer_group: log.consumerGroup || "",
      trace_id: ctx.traceId,
      span_id: ctx.spanId,
      payload: String(log.payload || "").slice(0, MAX_LOG_PAYLOAD_CHARS),
      release: "",
      commit: "",
    };
    this.client.captureLog(record);
  }
}

/**
 * The child spans of one request. They are held until the request finishes,
 * then sent only when the request was sampled in (its root span is sent
 * too); spans of work that outlives the response follow the same decision.
 */
export class RequestSpans implements SpanSink {
  private pending: ChildSpan[] = [];
  private decided = false;
  private keep = false;
  private ctx?: TraceContext;

  constructor(private readonly recorder: SpanRecorder) {}

  bind(ctx: TraceContext): void {
    this.ctx = ctx;
  }

  childSpan(span: ChildSpan): void {
    if (!this.decided) {
      if (this.pending.length < MAX_PENDING_SPANS) {
        this.pending.push(span);
      }
      return;
    }
    if (this.keep) {
      this.emit(span);
    }
  }

  /** The request finished: send (`keep`) or discard its child spans. */
  finish(keep: boolean): void {
    this.decided = true;
    this.keep = keep;
    const pending = this.pending;
    this.pending = [];
    if (keep) {
      for (const span of pending) {
        this.emit(span);
      }
    }
  }

  private emit(span: ChildSpan): void {
    if (!this.ctx) {
      return;
    }
    this.recorder.span(this.ctx, { ...span, parentSpanId: this.ctx.spanId });
  }
}

// ── Outbound HTTP auto-instrumentation ──────────────────────────────────────

/** An outbound call in flight: finished once with its status. */
type OutboundCall = {
  ctx: TraceContext;
  spanId: string;
  method: string;
  url: string;
  startedAt: Date;
  t0: number;
  done: boolean;
};

function beginCall(ctx: TraceContext, method: string, url: string): OutboundCall {
  return {
    ctx,
    spanId: generateSpanId(),
    method: String(method || "GET").toUpperCase(),
    url: stripUrl(url),
    startedAt: new Date(),
    t0: performance.now(),
    done: false,
  };
}

function finishCall(call: OutboundCall, statusCode: number, error: boolean): void {
  if (call.done) {
    return;
  }
  call.done = true;
  try {
    call.ctx.sink?.childSpan({
      spanId: call.spanId,
      name: `${call.method} ${call.url}`,
      kind: "http",
      startedAt: call.startedAt,
      durationMs: Math.max(performance.now() - call.t0, 0),
      status: error || statusCode >= 500 ? "error" : "ok",
      statusCode,
      attributes: {
        "http.method": call.method,
        "http.url": call.url,
        ...(statusCode ? { "http.status_code": String(statusCode) } : {}),
      },
    });
  } catch {
    // Never break the caller's request over span bookkeeping.
  }
}

type RequestFn = (...args: unknown[]) => http.ClientRequest;

const WRAPPED = Symbol.for("apilens.wrapped");

function traceClientRequest(req: http.ClientRequest, ctx: TraceContext): void {
  const host = String(req.getHeader("host") || req.host || "");
  const protocol = String(req.protocol || "http:");
  const call = beginCall(ctx, req.method, `${protocol}//${host}${req.path || "/"}`);
  if (!req.headersSent && req.getHeader("traceparent") === undefined) {
    req.setHeader("traceparent", formatTraceparent(ctx.traceId, call.spanId));
  }
  // Wrapping emit instead of adding listeners keeps Node's semantics: an
  // unhandled 'error' still throws, an unread response is still dumped.
  const emit = req.emit;
  req.emit = function patchedEmit(this: http.ClientRequest, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "response") {
      finishCall(call, Number((args[0] as http.IncomingMessage | undefined)?.statusCode) || 0, false);
    } else if (event === "error" || event === "close") {
      finishCall(call, 0, true);
    }
    return emit.call(this, event, ...args);
  } as typeof req.emit;
}

function wrapRequest(original: RequestFn): RequestFn {
  const wrapped = function apilensRequest(this: unknown, ...args: unknown[]): http.ClientRequest {
    const ctx = currentTraceContext();
    const req = original.apply(this, args);
    if (ctx?.sink) {
      try {
        traceClientRequest(req, ctx);
      } catch {
        // Instrumentation must never fail the call.
      }
    }
    return req;
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return wrapped;
}

function patchModule(mod: typeof http | typeof https): void {
  const current = mod.request as unknown as RequestFn & { [WRAPPED]?: boolean };
  if (current[WRAPPED]) {
    return;
  }
  const request = wrapRequest(current);
  // Same as Node's own `get`: request + end, through the wrapped request.
  const get = function apilensGet(this: unknown, ...args: unknown[]): http.ClientRequest {
    const req = request.apply(this, args);
    req.end();
    return req;
  };
  Object.defineProperty(get, WRAPPED, { value: true });
  (mod as { request: unknown }).request = request;
  (mod as { get: unknown }).get = get;
}

type UndiciRequest = {
  method?: string;
  origin?: string | URL;
  path?: string;
  headers?: string | string[];
  addHeader?: (name: string, value: string) => unknown;
};

const undiciCalls = new WeakMap<object, OutboundCall>();

function hasHeader(headers: string | string[] | undefined, name: string): boolean {
  if (Array.isArray(headers)) {
    return headers.some((value, i) => i % 2 === 0 && String(value).toLowerCase() === name);
  }
  if (typeof headers === "string") {
    return headers.toLowerCase().split("\r\n").some((line) => line.startsWith(`${name}:`));
  }
  return false;
}

function onUndiciCreate(message: unknown): void {
  const request = (message as { request?: UndiciRequest } | undefined)?.request;
  const ctx = currentTraceContext();
  if (!request || !ctx?.sink) {
    return;
  }
  try {
    const call = beginCall(ctx, request.method || "GET", `${String(request.origin || "")}${request.path || "/"}`);
    if (typeof request.addHeader === "function" && !hasHeader(request.headers, "traceparent")) {
      request.addHeader("traceparent", formatTraceparent(ctx.traceId, call.spanId));
    }
    undiciCalls.set(request as object, call);
  } catch {
    // Instrumentation must never fail the call.
  }
}

function onUndiciHeaders(message: unknown): void {
  const { request, response } = (message || {}) as { request?: object; response?: { statusCode?: number } };
  const call = request ? undiciCalls.get(request) : undefined;
  if (call) {
    undiciCalls.delete(request as object);
    finishCall(call, Number(response?.statusCode) || 0, false);
  }
}

function onUndiciError(message: unknown): void {
  const request = (message as { request?: object } | undefined)?.request;
  const call = request ? undiciCalls.get(request) : undefined;
  if (call) {
    undiciCalls.delete(request as object);
    finishCall(call, 0, true);
  }
}

function subscribe(name: string, handler: (message: unknown) => void): void {
  diagnosticsChannel.channel(name).subscribe(handler);
}

let outboundInstrumented = false;

/**
 * Trace outbound HTTP made while handling a request: `http`/`https`
 * `request`/`get` and `fetch`/undici. Idempotent; never throws. Calls made
 * outside a request (or by the SDK itself) are untouched.
 */
export function instrumentOutboundHttp(): void {
  if (outboundInstrumented) {
    return;
  }
  outboundInstrumented = true;
  try {
    patchModule(http);
    patchModule(https);
    // ESM named imports (`import { request } from "node:http"`) see the patch too.
    syncBuiltinESMExports();
  } catch {
    // Leave http untraced rather than fail.
  }
  try {
    subscribe("undici:request:create", onUndiciCreate);
    subscribe("undici:request:headers", onUndiciHeaders);
    subscribe("undici:request:error", onUndiciError);
  } catch {
    // diagnostics_channel unavailable: fetch stays untraced.
  }
}

/** Error log message and payload (the stack) for a failed request. */
export function errorLogContent(
  error: unknown,
  statusCode: number,
  method: string,
  path: string,
): { message: string; payload: string; loggerName: string } {
  if (error !== undefined && error !== null) {
    if (error instanceof Error) {
      return {
        message: `${error.name || "Error"}: ${error.message}`.trim(),
        payload: String(error.stack || ""),
        loggerName: "apilens.exception",
      };
    }
    return { message: `Error: ${String(error)}`, payload: "", loggerName: "apilens.exception" };
  }
  return { message: `HTTP ${statusCode} on ${method} ${path}`, payload: "", loggerName: "apilens.http" };
}
