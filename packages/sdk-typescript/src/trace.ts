/**
 * W3C Trace Context for request capture. Port of the Python SDK's
 * `apilens.client.trace`.
 *
 * Every captured request carries a `trace_id` (the whole distributed
 * transaction) and a `span_id` (this service's handling of it). When the
 * caller propagates a valid `traceparent` header the trace is continued;
 * otherwise a new one starts. The context lives in an `AsyncLocalStorage`,
 * so outbound `http`/`https`/`fetch` calls made while handling the request
 * (however deep in async code) become child spans and carry `traceparent`
 * downstream.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/** Where a request's spans and error log go (see `spans.ts`). */
export type SpanSink = {
  /** Queue one finished child span of this request. */
  childSpan: (span: ChildSpan) => void;
};

/** A finished outbound call, recorded as a child of the request span. */
export type ChildSpan = {
  spanId: string;
  name: string;
  kind: string;
  startedAt: Date;
  durationMs: number;
  status: "ok" | "error";
  statusCode: number;
  attributes: Record<string, string>;
};

export type TraceContext = {
  readonly traceId: string;
  /** This service's span for the request (the parent of outbound spans). */
  readonly spanId: string;
  /** The caller's span from `traceparent` ("" for a new trace). */
  readonly parentSpanId: string;
  readonly sink?: SpanSink;
};

const storage = new AsyncLocalStorage<TraceContext>();

/**
 * Parse a W3C `traceparent` header into `{ traceId, parentSpanId }`.
 * Undefined for a missing, malformed, version `ff` or all-zero value (per
 * spec an invalid traceparent is ignored and a new trace started).
 */
export function parseTraceparent(
  header: string | string[] | null | undefined,
): { traceId: string; parentSpanId: string } | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return undefined;
  }
  const match = TRACEPARENT_RE.exec(String(value).trim().toLowerCase());
  if (!match) {
    return undefined;
  }
  const [, version, traceId, spanId] = match;
  if (version === "ff" || traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return undefined;
  }
  return { traceId, parentSpanId: spanId };
}

/** 32 lower-case hex characters. */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** 16 lower-case hex characters. */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** `traceparent` value for a call made from `spanId` of `traceId` (sampled flag set). */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/**
 * The trace context for an incoming request: continues the caller's trace
 * when `traceparent` is valid, else starts a new one. `spanId` is always new.
 */
export function beginRequestTrace(
  traceparent: string | string[] | null | undefined,
  sink?: SpanSink,
): TraceContext {
  const parsed = parseTraceparent(traceparent);
  return {
    traceId: parsed?.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: parsed?.parentSpanId ?? "",
    sink,
  };
}

/** Run `fn` with `ctx` as the current trace context (and everything it awaits). */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Run `fn` outside any trace context (the SDK's own uploads are never traced). */
export function runWithoutTrace<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** The trace context of the request being handled, if any. */
export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Trace id of the request being handled ("" outside a request). */
export function currentTraceId(): string {
  return storage.getStore()?.traceId ?? "";
}

/** Span id of the request being handled ("" outside a request). */
export function currentSpanId(): string {
  return storage.getStore()?.spanId ?? "";
}

/** A `traceparent` value for propagating the current request downstream ("" outside one). */
export function currentTraceparent(): string {
  const ctx = storage.getStore();
  return ctx ? formatTraceparent(ctx.traceId, ctx.spanId) : "";
}
