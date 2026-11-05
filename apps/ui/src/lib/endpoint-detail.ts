// The endpoint detail page (#593): `/<project>/endpoints/<method>/<path>` with Requests, Errors,
// Response times and Data transferred tabs, and the endpoint's settings. Pure helpers (URL state,
// formatting, settings input), unit-tested in endpoint-detail.test.ts.
import { RANGE_LABEL } from "./consumers";
import type { EndpointSettings, LatencyBucket, PutEndpointSettingsRequest, QueryRange, SizeBucket, StatusClass } from "./identity";
import { DEFAULT_RANGE, TRAFFIC_RANGES } from "./traffic";

export const ENDPOINT_TABS = [
  { slug: "requests", label: "Requests" },
  { slug: "errors", label: "Errors" },
  { slug: "latency", label: "Response times" },
  { slug: "transfer", label: "Data transferred" },
] as const;
export type EndpointTab = (typeof ENDPOINT_TABS)[number]["slug"];
const DEFAULT_TAB: EndpointTab = "requests";

export const STATUS_CLASSES: readonly StatusClass[] = ["all", "2xx", "3xx", "4xx", "5xx"];

/** The longest environment name, consumer id and app slug the API takes. */
const MAX_ENV = 64;
const MAX_CONSUMER = 128;
const MAX_APP = 63;
/** The longest route template the API takes. */
const MAX_PATH = 1024;

/**
 * The page's state, all of it in the URL: `?tab=&range=&env=&status=&consumer=&app=`. Empty
 * env and consumer mean all; `app` picks the app whose settings the menu edits (else the first).
 */
export interface EndpointState {
  tab: EndpointTab;
  range: QueryRange;
  env: string;
  status: StatusClass;
  consumer: string;
  app: string;
}

/** The locked part of the scope: which endpoint the page is about. */
export interface EndpointRef {
  method: string;
  path: string;
}

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const capped = (v: string | string[] | undefined, max: number) => {
  const s = (first(v) ?? "").trim();
  return s.length <= max ? s : "";
};

/** Reads the page state from search params; anything unknown falls back to the default. */
export function parseEndpointQuery(params: SearchParams): EndpointState {
  const tab = first(params.tab);
  const range = first(params.range);
  const status = first(params.status);
  return {
    tab: ENDPOINT_TABS.some((t) => t.slug === tab) ? (tab as EndpointTab) : DEFAULT_TAB,
    range: TRAFFIC_RANGES.includes(range as QueryRange) ? (range as QueryRange) : DEFAULT_RANGE,
    env: capped(params.env, MAX_ENV),
    status: STATUS_CLASSES.includes(status as StatusClass) ? (status as StatusClass) : "all",
    consumer: capped(params.consumer, MAX_CONSUMER),
    app: capped(params.app, MAX_APP),
  };
}

/**
 * The endpoint named by the route's `method` and `path` segments, or null when it is not one the
 * API could answer. The path segment is the URL-encoded route template; it is decoded unless the
 * router already did.
 */
export function parseEndpointRef(method: string, path: string): EndpointRef | null {
  if (!/^[A-Za-z]{1,16}$/.test(method)) return null;
  let template = path;
  if (!template.startsWith("/")) {
    try {
      template = decodeURIComponent(template);
    } catch {
      return null;
    }
  }
  if (!template.startsWith("/") || template.length > MAX_PATH) return null;
  return { method: method.toUpperCase(), path: template };
}

/** The page URL for the endpoint in state `q`, leaving defaults out. */
export function endpointPageHref(project: string, ep: EndpointRef, q: Partial<EndpointState>): string {
  const p = new URLSearchParams();
  if (q.tab && q.tab !== DEFAULT_TAB) p.set("tab", q.tab);
  if (q.range && q.range !== DEFAULT_RANGE) p.set("range", q.range);
  if (q.env) p.set("env", q.env);
  if (q.status && q.status !== "all") p.set("status", q.status);
  if (q.consumer) p.set("consumer", q.consumer);
  if (q.app) p.set("app", q.app);
  const s = p.toString();
  return `/${encodeURIComponent(project)}/endpoints/${encodeURIComponent(ep.method)}/${encodeURIComponent(ep.path)}${s ? `?${s}` : ""}`;
}

/** Whether a tab's read takes the status filter (the errors read does not). */
export const tabTakesStatus = (tab: EndpointTab) => tab !== "errors";

/** The scope in words: `the last 24 hours in production, 5xx responses, consumer acme`. */
export function endpointScopeText(q: EndpointState, consumerLabel?: string): string {
  const parts = [`the last ${RANGE_LABEL[q.range]}${q.env ? ` in ${q.env}` : ""}`];
  if (q.status !== "all" && tabTakesStatus(q.tab)) parts.push(`${q.status} responses`);
  if (q.consumer) parts.push(`consumer ${consumerLabel || q.consumer}`);
  return parts.join(", ");
}

/** A byte count: `0 B`, `512 B`, `1.5 KB`, `12 MB` (1 KB = 1024 B). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  if (u === 0) return `${Math.round(v)} B`;
  const text = v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${text.replace(/\.0$/, "")} ${units[u]}`;
}

/** A millisecond histogram edge: `0 ms`, `500 ms`, `1 s`, `10 s`. */
const msEdge = (ms: number) => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`);

/** A response-time bucket's label: `100–200 ms`, `1–2 s`, `≥10 s`. */
export function latencyBucketLabel(b: Pick<LatencyBucket, "from_ms" | "to_ms">): string {
  if (b.to_ms === undefined || b.to_ms === null) return `≥${msEdge(b.from_ms)}`;
  const from = msEdge(b.from_ms);
  const to = msEdge(b.to_ms);
  // One unit when both edges share it: `100–200 ms`, not `100 ms–200 ms`.
  const [fv, fu] = from.split(" ");
  const [tv, tu] = to.split(" ");
  return fu === tu ? `${fv}–${tv} ${tu}` : `${from}–${to}`;
}

/** A body-size bucket's label: `0 B`, `1–256 B`, `1–4 KB`, `≥4 MB`. */
export function sizeBucketLabel(b: Pick<SizeBucket, "from_bytes" | "to_bytes">): string {
  if (b.to_bytes === undefined || b.to_bytes === null) return `≥${formatBytes(b.from_bytes)}`;
  // The first bucket holds empty bodies only.
  if (b.from_bytes === 0 && b.to_bytes === 1) return "0 B";
  const from = formatBytes(b.from_bytes);
  const to = formatBytes(b.to_bytes);
  const [fv, fu] = from.split(" ");
  const [tv, tu] = to.split(" ");
  return fu === tu ? `${fv}–${tv} ${tu}` : `${from}–${to}`;
}

/** A value already in percent (0 to 100): `0%`, `<0.1%`, `2.5%`, `12%`. */
export function formatPercent(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0%";
  if (v < 0.1) return "<0.1%";
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}%`;
}

/** A share from 0 to 1 as a percentage: `0%`, `<0.1%`, `12.5%`. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(Math.min(1, share) * 100).toFixed(1)}%`;
}

// Settings ---------------------------------------------------------------------------------

/** Most expected status codes the API takes. */
export const MAX_EXPECTED = 32;
/** The latency threshold range the API takes, in ms. */
export const MAX_THRESHOLD_MS = 600_000;

/** The settings form as typed: codes and threshold are free text. */
export interface SettingsDraft {
  codes: string;
  threshold: string;
  excluded: boolean;
}

export type SettingsErrors = Partial<Record<"codes" | "threshold", string>>;

export function settingsDraft(s: Pick<EndpointSettings, "expected_status_codes" | "latency_threshold_ms" | "excluded">): SettingsDraft {
  return {
    codes: (s.expected_status_codes ?? []).join(", "),
    threshold: s.latency_threshold_ms === null ? "" : String(s.latency_threshold_ms),
    excluded: s.excluded,
  };
}

/** Checks the form: codes separated by commas or spaces (100 to 599, at most 32), threshold in ms or empty. */
export function checkSettingsDraft(d: SettingsDraft): { ok: true; settings: PutEndpointSettingsRequest } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const tokens = d.codes.split(/[\s,]+/).filter(Boolean);
  const codes: number[] = [];
  for (const t of tokens) {
    const n = /^\d{3}$/.test(t) ? Number(t) : Number.NaN;
    if (!(n >= 100 && n <= 599)) {
      errors.codes = `“${t}” is not a status code. Use codes from 100 to 599, like 404, 409.`;
      break;
    }
    if (!codes.includes(n)) codes.push(n);
  }
  if (!errors.codes && codes.length > MAX_EXPECTED) errors.codes = `Mark at most ${MAX_EXPECTED} status codes as expected.`;
  const raw = d.threshold.trim();
  let threshold: number | null = null;
  if (raw) {
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(n >= 1 && n <= MAX_THRESHOLD_MS)) errors.threshold = `Enter whole milliseconds from 1 to ${MAX_THRESHOLD_MS.toLocaleString("en-US")}, or leave it empty for the app default.`;
    else threshold = n;
  }
  if (errors.codes || errors.threshold) return { ok: false, errors };
  return { ok: true, settings: { expected_status_codes: codes.sort((a, b) => a - b), latency_threshold_ms: threshold, excluded: d.excluded } };
}

/** Re-checks settings coming into the Server Action (a public endpoint). */
export function checkSettings(value: unknown): { ok: true; settings: PutEndpointSettingsRequest } | { ok: false } {
  if (typeof value !== "object" || value === null) return { ok: false };
  const v = value as Record<string, unknown>;
  const codes = v.expected_status_codes;
  const threshold = v.latency_threshold_ms;
  if (typeof v.excluded !== "boolean") return { ok: false };
  if (!Array.isArray(codes) || codes.length > MAX_EXPECTED || !codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599)) return { ok: false };
  if (threshold !== null && !(Number.isInteger(threshold) && (threshold as number) >= 1 && (threshold as number) <= MAX_THRESHOLD_MS)) return { ok: false };
  return { ok: true, settings: { expected_status_codes: [...new Set(codes as number[])].sort((a, b) => a - b), latency_threshold_ms: threshold as number | null, excluded: v.excluded } };
}

/** A sentence for an API error code when saving settings. */
export function settingsError(code: string): string {
  switch (code) {
    case "forbidden":
      return "Only project admins can change endpoint settings.";
    case "not_found":
      return "This app no longer exists, or you’re no longer a member of its project.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check the status codes and the threshold, and try again.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

// The endpoint row menu (#600): one-step changes to saved settings ---------------------------

/** The status code the row menu's "Mark 404 as expected" toggles. */
export const QUICK_EXPECTED = 404;

type SavedSettings = Pick<EndpointSettings, "expected_status_codes" | "latency_threshold_ms" | "excluded">;

/** The settings as the API takes them back, unchanged. */
export function settingsBody(s: SavedSettings): PutEndpointSettingsRequest {
  return { expected_status_codes: [...(s.expected_status_codes ?? [])].sort((a, b) => a - b), latency_threshold_ms: s.latency_threshold_ms, excluded: s.excluded };
}

/** Whether `code` is one of the endpoint's expected status codes. */
export function isExpected(s: SavedSettings, code: number): boolean {
  return (s.expected_status_codes ?? []).includes(code);
}

/** The settings with `code` added to the expected codes, or taken out when it is already there. */
export function toggleExpected(s: SavedSettings, code: number): PutEndpointSettingsRequest {
  const body = settingsBody(s);
  const codes = isExpected(s, code) ? body.expected_status_codes.filter((c) => c !== code) : [...body.expected_status_codes, code];
  return { ...body, expected_status_codes: codes.sort((a, b) => a - b) };
}

/** The settings with the latency threshold typed in `raw` (empty means the app default), or the error to show. */
export function withThreshold(s: SavedSettings, raw: string): { ok: true; settings: PutEndpointSettingsRequest } | { ok: false; error: string } {
  const checked = checkSettingsDraft({ ...settingsDraft(s), threshold: raw });
  if (!checked.ok) return { ok: false, error: checked.errors.threshold ?? checked.errors.codes ?? settingsError("invalid_request") };
  return { ok: true, settings: { ...settingsBody(s), latency_threshold_ms: checked.settings.latency_threshold_ms } };
}

/** A sentence for an API error code when the row menu reads an endpoint's settings. */
export function loadSettingsError(code: string): string {
  if (code === "forbidden" || code === "invalid_request" || code === "validation_failed" || code === "bad_request") {
    return "We couldn’t load this endpoint’s settings just now. Try again in a moment.";
  }
  return settingsError(code);
}

/** The threshold as the row menu shows it: `250 ms`, or `App default`. */
export function thresholdText(ms: number | null): string {
  return ms === null ? "App default" : `${ms.toLocaleString("en-US")} ms`;
}

export const tabLoadFailed = (tab: EndpointTab) =>
  `We couldn’t load ${ENDPOINT_TABS.find((t) => t.slug === tab)?.label.toLowerCase() ?? "this tab"} just now.`;
