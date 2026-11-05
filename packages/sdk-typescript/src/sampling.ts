/**
 * Request sampling. Port of the Python SDK's sampling semantics.
 *
 * Sampling only ever drops request DETAIL (headers and bodies, and spans and
 * logs once the SDK emits them). A sampled-out request still sends its base
 * record (method, path, status, latency, sizes, consumer) with
 * `sampled: false`, because records double as metrics: traffic counts, error
 * rates and latency percentiles are derived from them, so sampling never
 * changes metrics.
 *
 * The decision is made in up to three steps:
 *
 * 1. `sampleOnRequest(info)` runs when the request arrives, before any
 *    response body is buffered. `true` / `false` is final, a number is a
 *    probability in [0, 1], `undefined` / `null` falls back to `sampleRate`.
 * 2. `sampleRate` (default 1) is the probability used when there is no
 *    request callback or it returned `undefined`.
 * 3. `sampleOnResponse(info)` runs after the response, with the status code
 *    and latency. Same return values; `undefined` keeps the prior decision.
 *    It can drop a sampled-in request but never resurrect one that was
 *    sampled out at request time (its body was never buffered).
 *
 * A callback that throws is logged once and treated as `undefined`; the
 * error never reaches the request handler.
 */

import type { Logger } from "./types.js";

/** What a sampling callback may return. */
export type SampleDecision = boolean | number | null | undefined;

/** Request-stage view passed to `sampleOnRequest`. */
export type SampleRequestInfo = {
  readonly method: string;
  /** Request path as received, without the query string. */
  readonly path: string;
  /** Raw query string without the leading `?` (empty when none). */
  readonly query: string;
  readonly userAgent: string;
  /** Incoming request headers, lower-cased names. Do not mutate. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly clientIp: string;
};

/** Response-stage view passed to `sampleOnResponse`. */
export type SampleResponseInfo = {
  readonly method: string;
  /** Route template used as the endpoint (e.g. `/orders/:id`). */
  readonly route: string;
  /** Request path as received, without the query string. */
  readonly rawPath: string;
  readonly statusCode: number;
  readonly responseTimeMs: number;
  readonly consumerId: string;
  readonly consumerName: string;
  readonly consumerGroup: string;
  /** The decision so far (always true: sampled-out requests stay out). */
  readonly sampled: boolean;
};

export type SampleOnRequest = (info: SampleRequestInfo) => SampleDecision;
export type SampleOnResponse = (info: SampleResponseInfo) => SampleDecision;

export type SamplerOptions = {
  /** Probability in [0, 1] that a request keeps its detail (default 1). */
  sampleRate?: number;
  sampleOnRequest?: SampleOnRequest;
  sampleOnResponse?: SampleOnResponse;
  logger?: Logger;
  /** Uniform [0, 1) source; injectable for tests. Defaults to `Math.random`. */
  random?: () => number;
};

/**
 * Validate a sample rate: a finite number in [0, 1]. `undefined` means 1.
 * Throws a `RangeError` otherwise, so misconfiguration fails at startup.
 */
export function validateSampleRate(value: unknown): number {
  if (value === undefined || value === null) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`sampleRate must be a number between 0 and 1, got ${String(value)}`);
  }
  return value;
}

export class Sampler {
  readonly sampleRate: number;
  private readonly onRequest?: SampleOnRequest;
  private readonly onResponse?: SampleOnResponse;
  private readonly logger?: Logger;
  private readonly random: () => number;
  private loggedRequestError = false;
  private loggedResponseError = false;

  constructor(options: SamplerOptions = {}) {
    this.sampleRate = validateSampleRate(options.sampleRate);
    if (options.sampleOnRequest !== undefined && typeof options.sampleOnRequest !== "function") {
      throw new TypeError("sampleOnRequest must be a function");
    }
    if (options.sampleOnResponse !== undefined && typeof options.sampleOnResponse !== "function") {
      throw new TypeError("sampleOnResponse must be a function");
    }
    this.onRequest = options.sampleOnRequest;
    this.onResponse = options.sampleOnResponse;
    this.logger = options.logger;
    this.random = options.random || Math.random;
  }

  /** Request-stage decision. `info` is built lazily, only for a callback. */
  decideRequest(info: () => SampleRequestInfo): boolean {
    let decision: SampleDecision;
    if (this.onRequest) {
      try {
        decision = this.onRequest(info());
      } catch (error) {
        if (!this.loggedRequestError) {
          this.loggedRequestError = true;
          this.logger?.warn?.("API Lens sampleOnRequest threw; treating it as undefined", error);
        }
        decision = undefined;
      }
    }
    const resolved = this.resolve(decision);
    return resolved === undefined ? this.roll(this.sampleRate) : resolved;
  }

  /**
   * Response-stage decision. A request already sampled out stays out and the
   * callback is not called.
   */
  decideResponse(prior: boolean, info: () => SampleResponseInfo): boolean {
    if (!prior || !this.onResponse) {
      return prior;
    }
    let decision: SampleDecision;
    try {
      decision = this.onResponse(info());
    } catch (error) {
      if (!this.loggedResponseError) {
        this.loggedResponseError = true;
        this.logger?.warn?.("API Lens sampleOnResponse threw; treating it as undefined", error);
      }
      decision = undefined;
    }
    const resolved = this.resolve(decision);
    return resolved === undefined ? prior : resolved;
  }

  private resolve(decision: SampleDecision): boolean | undefined {
    if (typeof decision === "boolean") {
      return decision;
    }
    if (typeof decision === "number" && !Number.isNaN(decision)) {
      return this.roll(Math.min(Math.max(decision, 0), 1));
    }
    return undefined;
  }

  private roll(rate: number): boolean {
    if (rate >= 1) {
      return true;
    }
    if (rate <= 0) {
      return false;
    }
    return this.random() < rate;
  }
}
