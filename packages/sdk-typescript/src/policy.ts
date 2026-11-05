/**
 * Remote capture policy: the `policy` object of the `POST /v1/heartbeat`
 * response (contract: apps/docs/ingest/heartbeat.mdx).
 *
 * The policy only ever NARROWS what the SDK captures. A local setting that
 * captures less (headers off, a lower sample rate, a smaller payload cap)
 * always wins; a remote value that would capture more is ignored. A policy
 * field that is missing or malformed narrows nothing.
 */

import type { ApiLensRecord } from "./types.js";

export type RemotePolicy = {
  /** False: stop sending records (heartbeats continue). */
  enabled: boolean;
  /** Fraction of requests that keep their detail, in [0, 1]. */
  sampleRate: number;
  captureHeaders: boolean;
  captureRequestBody: boolean;
  captureResponseBody: boolean;
  /** Cap on each captured body in bytes; null: no cap beyond the SDK's own. */
  maxPayloadBytes: number | null;
};

/** The policy of an app without a saved one: capture everything. */
export const CAPTURE_EVERYTHING: Readonly<RemotePolicy> = Object.freeze({
  enabled: true,
  sampleRate: 1,
  captureHeaders: true,
  captureRequestBody: true,
  captureResponseBody: true,
  maxPayloadBytes: null,
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `false` only for an explicit boolean false; anything else narrows nothing. */
function flag(value: unknown): boolean {
  return value !== false;
}

/**
 * The policy in a heartbeat response body, or undefined when the body has
 * none (the caller then keeps its previous policy).
 */
export function parseRemotePolicy(body: unknown): RemotePolicy | undefined {
  if (!isObject(body) || !isObject(body.policy)) {
    return undefined;
  }
  const raw = body.policy;

  let sampleRate = 1;
  if (typeof raw.sample_rate === "number" && Number.isFinite(raw.sample_rate)) {
    sampleRate = Math.min(Math.max(raw.sample_rate, 0), 1);
  }

  let maxPayloadBytes: number | null = null;
  if (
    typeof raw.max_payload_bytes === "number"
    && Number.isFinite(raw.max_payload_bytes)
    && raw.max_payload_bytes >= 0
  ) {
    maxPayloadBytes = Math.floor(raw.max_payload_bytes);
  }

  return {
    enabled: flag(raw.enabled),
    sampleRate,
    captureHeaders: flag(raw.capture_headers),
    captureRequestBody: flag(raw.capture_request_body),
    captureResponseBody: flag(raw.capture_response_body),
    maxPayloadBytes,
  };
}

/** The smaller of the local payload cap and the policy's (null: local only). */
export function narrowPayloadBytes(local: number, policy: RemotePolicy | null | undefined): number {
  const remote = policy?.maxPayloadBytes;
  return remote === null || remote === undefined ? local : Math.min(local, remote);
}

/** Cut `value` to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) {
    return value;
  }
  const cut = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  // A split multi-byte character decodes to U+FFFD; drop it.
  return cut.endsWith("�") ? cut.slice(0, -1) : cut;
}

/**
 * Apply `policy` to `record` in place. Returns false when the record must not
 * be sent at all (capture disabled remotely).
 *
 * Narrow-only: fields are only ever removed or shortened, `sampled` only ever
 * goes from true to false, never the reverse. A request sampled out by the
 * remote rate keeps its base record (it still counts in metrics), exactly
 * like local sampling.
 */
export function applyRemotePolicy(
  record: ApiLensRecord,
  policy: RemotePolicy,
  random: () => number = Math.random,
): boolean {
  if (!policy.enabled) {
    return false;
  }

  if (record.sampled && policy.sampleRate < 1 && !(random() < policy.sampleRate)) {
    record.sampled = false;
  }
  if (!record.sampled) {
    record.request_payload = "";
    record.response_payload = "";
    record.request_headers = "";
    record.response_headers = "";
    return true;
  }

  if (!policy.captureHeaders) {
    record.request_headers = "";
    record.response_headers = "";
  }
  if (!policy.captureRequestBody) {
    record.request_payload = "";
  }
  if (!policy.captureResponseBody) {
    record.response_payload = "";
  }
  if (policy.maxPayloadBytes !== null) {
    record.request_payload = truncateToBytes(record.request_payload, policy.maxPayloadBytes);
    record.response_payload = truncateToBytes(record.response_payload, policy.maxPayloadBytes);
  }
  return true;
}
