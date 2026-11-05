// Project settings → Capture (#598): an app's remote capture policy (`GET|PUT
// /apps/{id}/capture-policy`) and what its SDKs reported running with (`GET /apps/{id}/metadata`).
// The form's checks, the narrower-of-the-two rule the page shows per environment, and the
// sentences shown for the server's error codes. The server stays the authority; these checks only
// spare a round trip. Pure; safe in Client Components and Server Actions alike.
import type { CapturePolicy, PutCapturePolicyRequest } from "./identity";

/** The section of project settings that edits capture policies. */
export const CAPTURE_SECTION = "capture";

/** `/<project>/settings/capture`, on `app` when given. */
export function capturePath(project: string, app?: string): string {
  const base = `/${project}/settings/${CAPTURE_SECTION}`;
  return app ? `${base}?app=${encodeURIComponent(app)}` : base;
}

/** Largest body cap the API accepts (`maximum` of `max_payload_bytes`): 1 MiB. */
export const MAX_PAYLOAD_LIMIT = 1_048_576;

/** How long until SDKs apply a saved policy: the edge's app cache TTL (`ingest.app_cache_ttl`). */
export const APPLIES_WITHIN = "60 s";

/** What an app captures when its policy was never saved. */
export const DEFAULT_POLICY: PutCapturePolicyRequest = {
  enabled: true,
  sample_rate: 1,
  capture_headers: true,
  capture_request_body: true,
  capture_response_body: true,
  max_payload_bytes: null,
};

/** The form's values as typed: the sample rate in percent and the cap in bytes, both as text. */
export interface PolicyDraft {
  enabled: boolean;
  /** Percent, 0 to 100, at most 2 decimals; e.g. "25". */
  percent: string;
  capture_headers: boolean;
  capture_request_body: boolean;
  capture_response_body: boolean;
  /** Bytes; empty for no cap. */
  cap: string;
}

/** The draft a saved policy starts the form from. */
export function draftOf(p: PutCapturePolicyRequest): PolicyDraft {
  return {
    enabled: p.enabled,
    percent: percentText(p.sample_rate),
    capture_headers: p.capture_headers,
    capture_request_body: p.capture_request_body,
    capture_response_body: p.capture_response_body,
    cap: p.max_payload_bytes === null ? "" : String(p.max_payload_bytes),
  };
}

/** `0.25` → `"25"`, `0.125` → `"12.5"`. */
export function percentText(rate: number): string {
  return String(Math.round(rate * 10_000) / 100);
}

const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;
const BYTES = /^\d{1,7}$/;

export type FieldErrors = Partial<Record<"percent" | "cap", string>>;

/** The policy as the API wants it, or why each field cannot be saved. */
export function checkDraft(d: PolicyDraft): { ok: true; policy: PutCapturePolicyRequest } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const percent = d.percent.trim();
  let rate = 0;
  if (!PERCENT.test(percent) || Number(percent) > 100) errors.percent = "Enter a percentage from 0 to 100, with at most 2 decimals.";
  else rate = Math.round(Number(percent) * 100) / 10_000;
  const capText = d.cap.trim();
  let cap: number | null = null;
  if (capText) {
    cap = BYTES.test(capText) ? Number(capText) : Number.NaN;
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_PAYLOAD_LIMIT) errors.cap = `Enter a size from 1 to ${MAX_PAYLOAD_LIMIT.toLocaleString("en-US")} bytes, or leave it empty.`;
  }
  if (errors.percent || errors.cap) return { ok: false, errors };
  return {
    ok: true,
    policy: {
      enabled: d.enabled,
      sample_rate: rate,
      capture_headers: d.capture_headers,
      capture_request_body: d.capture_request_body,
      capture_response_body: d.capture_response_body,
      max_payload_bytes: cap,
    },
  };
}

/** Checks a policy a Server Action received, field by field, against the API's rules. */
export function checkPolicy(value: unknown): { ok: true; policy: PutCapturePolicyRequest } | { ok: false; error: string } {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const flags = ["enabled", "capture_headers", "capture_request_body", "capture_response_body"] as const;
  if (flags.some((f) => typeof v[f] !== "boolean")) return { ok: false, error: captureError("invalid_request") };
  const rate = v.sample_rate;
  if (typeof rate !== "number" || !(rate >= 0 && rate <= 1) || Math.round(rate * 10_000) / 10_000 !== rate) return { ok: false, error: captureError("invalid_request") };
  const cap = v.max_payload_bytes ?? null;
  if (cap !== null && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > MAX_PAYLOAD_LIMIT)) return { ok: false, error: captureError("invalid_request") };
  return {
    ok: true,
    policy: {
      enabled: v.enabled as boolean,
      sample_rate: rate,
      capture_headers: v.capture_headers as boolean,
      capture_request_body: v.capture_request_body as boolean,
      capture_response_body: v.capture_response_body as boolean,
      max_payload_bytes: cap as number | null,
    },
  };
}

/** The saveable part of a policy read from the API. */
export function policyValues(p: CapturePolicy): PutCapturePolicyRequest {
  return {
    enabled: p.enabled,
    sample_rate: p.sample_rate,
    capture_headers: p.capture_headers,
    capture_request_body: p.capture_request_body,
    capture_response_body: p.capture_response_body,
    max_payload_bytes: p.max_payload_bytes,
  };
}

/** Whether two policies save the same thing. */
export function samePolicy(a: PutCapturePolicyRequest, b: PutCapturePolicyRequest): boolean {
  return (
    a.enabled === b.enabled &&
    a.sample_rate === b.sample_rate &&
    a.capture_headers === b.capture_headers &&
    a.capture_request_body === b.capture_request_body &&
    a.capture_response_body === b.capture_response_body &&
    a.max_payload_bytes === b.max_payload_bytes
  );
}

/** `25%`, `12.5%`. */
export function formatRate(rate: number): string {
  return `${percentText(rate)}%`;
}

/** `65,536 bytes (64 KiB)`; `No cap` for null. */
export function formatCap(bytes: number | null): string {
  if (bytes === null) return "No cap";
  const exact = `${bytes.toLocaleString("en-US")} bytes`;
  if (bytes >= 1024 && bytes % 1024 === 0) {
    const kib = bytes / 1024;
    return `${exact} (${kib % 1024 === 0 ? `${kib / 1024} MiB` : `${kib} KiB`})`;
  }
  return exact;
}

/** One setting compared: the remote policy, what the SDK reported, and what applies. */
export interface EffectiveRow {
  label: string;
  policy: string;
  /** Null when the SDK did not report this setting. */
  sdk: string | null;
  effective: string;
  /** The SDK's own config is what narrows this setting. */
  narrowedBySdk: boolean;
}

const yesNo = (on: boolean) => (on ? "On" : "Off");

function flag(config: Record<string, unknown>, key: string): boolean | null {
  const v = config[key];
  return typeof v === "boolean" ? v : null;
}

function num(config: Record<string, unknown>, key: string): number | null {
  const v = config[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Each setting of `policy` next to the SDK's reported `config` and the narrower of the two, which
 * is what the SDK applies: a flag is on only when both are on, the sample rate is the lower one,
 * the body cap the smaller one. A setting the SDK did not report follows the policy.
 */
export function effectiveRows(policy: PutCapturePolicyRequest, config: Record<string, unknown>): EffectiveRow[] {
  const flagRow = (label: string, on: boolean, key: string): EffectiveRow => {
    const sdk = flag(config, key);
    return { label, policy: yesNo(on), sdk: sdk === null ? null : yesNo(sdk), effective: yesNo(on && sdk !== false), narrowedBySdk: on && sdk === false };
  };
  const rawRate = num(config, "sample_rate");
  const sdkRate = rawRate !== null && rawRate >= 0 && rawRate <= 1 ? rawRate : null;
  const rate = sdkRate === null ? policy.sample_rate : Math.min(policy.sample_rate, sdkRate);
  const rawCap = num(config, "max_payload_bytes");
  const sdkCap = rawCap !== null && rawCap > 0 ? Math.floor(rawCap) : null;
  const cap = sdkCap === null ? policy.max_payload_bytes : policy.max_payload_bytes === null ? sdkCap : Math.min(policy.max_payload_bytes, sdkCap);
  return [
    flagRow("Capture", policy.enabled, "enabled"),
    { label: "Sample rate", policy: formatRate(policy.sample_rate), sdk: sdkRate === null ? null : formatRate(sdkRate), effective: formatRate(rate), narrowedBySdk: sdkRate !== null && sdkRate < policy.sample_rate },
    flagRow("Headers", policy.capture_headers, "capture_headers"),
    flagRow("Request bodies", policy.capture_request_body, "capture_request_body"),
    flagRow("Response bodies", policy.capture_response_body, "capture_response_body"),
    { label: "Body size cap", policy: formatCap(policy.max_payload_bytes), sdk: sdkCap === null ? null : formatCap(sdkCap), effective: formatCap(cap), narrowedBySdk: sdkCap !== null && cap === sdkCap && cap !== policy.max_payload_bytes },
  ];
}

/** `fastapi 0.115 · Python 3.12.4 · SDK 0.6.0`, skipping what was not reported. */
export function runtimeLine(r: { framework: string; framework_version: string; runtime_version: string; sdk_version: string }): string {
  const framework = [r.framework, r.framework_version].filter(Boolean).join(" ");
  return [framework, r.runtime_version, r.sdk_version ? `SDK ${r.sdk_version}` : ""].filter(Boolean).join(" · ");
}

/** App ids are UUIDs (`format: uuid`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAppId(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

/** The sentence the capture page shows for an API error `code`. */
export function captureError(code: string): string {
  switch (code) {
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check the sample rate and the body size cap, and try again.";
    case "forbidden":
      return "Only project admins can change the capture policy.";
    case "not_found":
      return "This app no longer exists, or you’re no longer a member of its project.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
