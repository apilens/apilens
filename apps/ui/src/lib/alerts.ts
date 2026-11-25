// Alerts (#610): the incidents feed, alert rules and notification channels over the alerts API
// (#609). Pure helpers, so the labels, the value formats, the rule and channel form checks and
// the error copy are unit-tested (alerts.test.ts).
import type {
  AlertCondition,
  AlertEvent,
  AlertMetric,
  AlertRule,
  AlertRuleBody,
  AlertStatus,
  ChannelConfig,
  ChannelType,
  Incident,
  IncidentsRange,
} from "./identity";
import type { PageOptions } from "./pagination";
import { formatAgo } from "./first-data";
import { formatPercent } from "./format";

// ---------------------------------------------------------------- routes

/** The project settings section that holds the notification channels. */
export const CHANNELS_SECTION = "alerts";

const base = (project: string) => `/${encodeURIComponent(project)}`;
export const incidentsHref = (project: string, range?: IncidentsRange) =>
  `${base(project)}/incidents${range && range !== INCIDENTS_RANGE ? `?range=${range}` : ""}`;
export const incidentHref = (project: string, ruleId: string) => `${base(project)}/incidents/${encodeURIComponent(ruleId)}`;
export const rulesHref = (project: string) => `${base(project)}/incidents/rules`;
export const newRuleHref = (project: string) => `${base(project)}/incidents/rules/new`;
export const ruleHref = (project: string, id: string) => `${base(project)}/incidents/rules/${encodeURIComponent(id)}`;
export const channelsHref = (project: string) => `${base(project)}/settings/${CHANNELS_SECTION}`;

// ---------------------------------------------------------------- incidents

/**
 * The incidents page pages its two lists apart: open incidents under `?opage=&oper=`, resolved
 * ones under `?page=&per=`. Another range starts both again at page 1 (incidentsHref keeps only
 * the range).
 */
export const OPEN_PAGING: PageOptions = { keys: { page: "opage", per: "oper" } };
export const RESOLVED_PAGING: PageOptions = {};
/** How many of a rule's incidents one page of its timeline shows. */
export const EVENTS_PAGE = 25;

export const INCIDENTS_RANGE: IncidentsRange = "7d";
export const INCIDENTS_RANGES: { value: IncidentsRange; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

/** The `?range=` of the incidents page, or the default. */
export function incidentsRange(value: unknown): IncidentsRange {
  return INCIDENTS_RANGES.some((r) => r.value === value) ? (value as IncidentsRange) : INCIDENTS_RANGE;
}

/** How many incidents are open: the sidebar's badge. */
export function openCount(incidents: readonly Pick<Incident, "open">[] | null | undefined): number {
  return (incidents ?? []).filter((i) => i.open).length;
}

/** The badge text: nothing at zero, `99+` past 99. */
export function badgeText(open: number): string {
  if (!Number.isFinite(open) || open <= 0) return "";
  return open > 99 ? "99+" : String(Math.floor(open));
}

export const STATUS_LABEL: Record<AlertStatus, string> = {
  ok: "OK",
  pending: "Pending",
  triggered: "Triggered",
  resolving: "Resolving",
};

/** `ok` and `resolving` read calm; `pending` warns; `triggered` is an error. */
export function statusTone(status: AlertStatus): "ok" | "warn" | "error" | "none" {
  if (status === "triggered") return "error";
  if (status === "pending") return "warn";
  if (status === "resolving") return "ok";
  return "none";
}

/** A span of seconds as people read it: `45 s`, `12 min`, `3 h 20 min`, `2 d 4 h`. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** How long an event lasted, or has lasted so far while it is open. */
export function eventDuration(e: Pick<AlertEvent, "started_at" | "ended_at">, now: number): string {
  const start = Date.parse(e.started_at);
  if (Number.isNaN(start)) return "";
  const end = e.ended_at ? Date.parse(e.ended_at) : now;
  if (Number.isNaN(end)) return "";
  return formatSpan((end - start) / 1000);
}

/** A list heading's count as a screen reader says it: `1 incident`, `4 incidents`. */
export function incidentCount(n: number): string {
  return `${n} ${n === 1 ? "incident" : "incidents"}`;
}

/** The value that opened an incident, apart from where the rule stands now: `Triggered at 3.4%`. */
export function triggeredText(metric: AlertMetric, value: number | null | undefined): string {
  return `Triggered at ${formatMetric(metric, value)}`;
}

/**
 * Where a rule stands at its latest check, and when that was: `Now 2.0% · checked 40s ago`.
 * `Not evaluated yet` before the first check.
 */
export function currentText(rule: Pick<AlertRule, "metric" | "state">, now: number): string {
  const s = rule.state;
  if (!s) return "Not evaluated yet";
  const ago = formatAgo(s.evaluated_at, now);
  return `Now ${formatMetric(rule.metric, s.value)}${ago ? ` · checked ${ago}` : ""}`;
}

/**
 * Whether anyone was told about an incident, when nobody was: `Not yet` while it is open,
 * `No notification sent` once resolved, and `No channel, nobody notified` when its rule has no
 * channel (#978). Null once a notification went out (the page shows when).
 */
export function unnotifiedText(e: Pick<AlertEvent, "ended_at" | "notified_at">, noChannel: boolean): string | null {
  if (e.notified_at) return null;
  if (noChannel) return "No channel, nobody notified";
  return e.ended_at ? "No notification sent" : "Not yet";
}

// ---------------------------------------------------------------- metrics

/** `rate` is stored 0..1 and entered in percent; `pct` is a percent 0..100 as stored. */
type Unit = "count" | "rate" | "pct" | "ms" | "score";

/**
 * The alert metrics in the editor's order: the request metrics, then the runtime resources (M7,
 * #1135), which read the SDK heartbeats and take no filters. `defaultCondition` and
 * `defaultThreshold` (API units: rates 0..1, percents 0..100, times in ms) are what a rule starts
 * at when its metric is picked (#982), so a switch never carries `p95 > 5 ms` or `Apdex above 5`
 * over from the last metric.
 */
export const METRICS: { value: AlertMetric; label: string; unit: Unit; defaultCondition: AlertCondition; defaultThreshold: number }[] = [
  { value: "traffic", label: "Requests", unit: "count", defaultCondition: "lt", defaultThreshold: 1 },
  { value: "errors", label: "Errors (4xx + 5xx)", unit: "count", defaultCondition: "gt", defaultThreshold: 10 },
  { value: "error_rate", label: "Error rate (4xx + 5xx)", unit: "rate", defaultCondition: "gt", defaultThreshold: 0.05 },
  { value: "server_errors", label: "Server errors (5xx)", unit: "count", defaultCondition: "gt", defaultThreshold: 10 },
  { value: "server_error_rate", label: "Server error rate (5xx)", unit: "rate", defaultCondition: "gt", defaultThreshold: 0.05 },
  { value: "client_errors", label: "Client errors (4xx)", unit: "count", defaultCondition: "gt", defaultThreshold: 50 },
  { value: "client_error_rate", label: "Client error rate (4xx)", unit: "rate", defaultCondition: "gt", defaultThreshold: 0.1 },
  { value: "p50", label: "p50 response time", unit: "ms", defaultCondition: "gt", defaultThreshold: 500 },
  { value: "p75", label: "p75 response time", unit: "ms", defaultCondition: "gt", defaultThreshold: 750 },
  { value: "p95", label: "p95 response time", unit: "ms", defaultCondition: "gt", defaultThreshold: 1000 },
  { value: "apdex", label: "Apdex", unit: "score", defaultCondition: "lt", defaultThreshold: 0.85 },
  { value: "unique_consumers", label: "Unique consumers", unit: "count", defaultCondition: "lt", defaultThreshold: 1 },
  { value: "cpu_pct_of_limit", label: "CPU (% of limit)", unit: "pct", defaultCondition: "gt", defaultThreshold: 90 },
  { value: "memory_pct_of_limit", label: "Memory (% of limit)", unit: "pct", defaultCondition: "gt", defaultThreshold: 90 },
  { value: "cpu_throttled_ratio", label: "CPU throttling", unit: "rate", defaultCondition: "gt", defaultThreshold: 0.25 },
  { value: "event_loop_p99_ms", label: "Event-loop delay p99", unit: "ms", defaultCondition: "gt", defaultThreshold: 200 },
  { value: "gc_pause_pct", label: "GC pause time", unit: "pct", defaultCondition: "gt", defaultThreshold: 10 },
  { value: "oom_kills", label: "OOM kills", unit: "count", defaultCondition: "gt", defaultThreshold: 0 },
  { value: "restarts", label: "Restarts", unit: "count", defaultCondition: "gt", defaultThreshold: 0 },
];

/** The metrics over runtime resources, not requests: filters do not apply to them. */
const RESOURCE_METRICS = new Set<AlertMetric>(["cpu_pct_of_limit", "memory_pct_of_limit", "cpu_throttled_ratio", "event_loop_p99_ms", "gc_pause_pct", "oom_kills", "restarts"]);
export const isResourceMetric = (metric: AlertMetric): boolean => RESOURCE_METRICS.has(metric);

const unitOf = (metric: AlertMetric): Unit => METRICS.find((m) => m.value === metric)?.unit ?? "count";
export const metricLabel = (metric: AlertMetric): string => METRICS.find((m) => m.value === metric)?.label ?? metric;

export const CONDITIONS: { value: AlertCondition; label: string; symbol: string }[] = [
  { value: "gt", label: "is above", symbol: ">" },
  { value: "gte", label: "is at or above", symbol: "≥" },
  { value: "lt", label: "is below", symbol: "<" },
  { value: "lte", label: "is at or below", symbol: "≤" },
];
export const conditionSymbol = (c: AlertCondition): string => CONDITIONS.find((x) => x.value === c)?.symbol ?? c;

/** What the threshold field is entered in for `metric`: rates and percents in percent, the rest as stored. */
export function thresholdUnit(metric: AlertMetric): string {
  switch (unitOf(metric)) {
    case "rate":
    case "pct":
      return "%";
    case "ms":
      return "ms";
    case "score":
      return "0 to 1";
    default:
      if (metric === "unique_consumers") return "consumers";
      if (metric === "oom_kills") return "OOM kills";
      if (metric === "restarts") return "restarts";
      return metric === "traffic" ? "requests" : "errors";
  }
}

const COUNT = new Intl.NumberFormat("en-US");

/** A metric value in its unit: `1,204`, `3.4%`, `412 ms`, `0.82`. */
export function formatMetric(metric: AlertMetric, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  switch (unitOf(metric)) {
    case "rate":
      // Two decimals under 1% so a 0.25% threshold reads as entered.
      return formatPercent(value, { digits: value > 0 && value < 0.01 ? 2 : 1 });
    case "pct":
      return formatPercent(value / 100);
    case "ms":
      return value >= 1000 ? `${Number((value / 1000).toFixed(2))} s` : `${Math.round(value)} ms`;
    case "score":
      return value.toFixed(2);
    default:
      return COUNT.format(Math.round(value));
  }
}

/** The breach condition, e.g. `> 2%`, `≥ 500 ms`, `< 0.85`. */
export function conditionText(metric: AlertMetric, condition: AlertCondition, threshold: number): string {
  return `${conditionSymbol(condition)} ${formatMetric(metric, threshold)}`;
}

/** How often a rule is evaluated: `every 1 min`, or its cron schedule. */
export function scheduleText(rule: Pick<AlertRule, "every_s" | "cron">): string {
  if (rule.cron) return `cron ${rule.cron} (UTC)`;
  return `every ${formatSpan(rule.every_s ?? 60)}`;
}

/** The one-line summary of a rule: `Error rate > 2% over 5 min`. */
export function ruleSummary(rule: Pick<AlertRule, "metric" | "condition" | "threshold" | "window_s">): string {
  return `${metricLabel(rule.metric)} ${conditionText(rule.metric, rule.condition, rule.threshold)} over ${formatSpan(rule.window_s)}`;
}

/** A rule's filters as short labels, endpoint first: "POST /checkout", "consumer alice", "group Acme Corp". */
export function filterParts(rule: Pick<AlertRule, "filters">): string[] {
  const f = rule.filters ?? {};
  return [f.endpoint ?? "", f.consumer ? `consumer ${f.consumer}` : "", f.group ? `group ${f.group}` : ""].filter(Boolean);
}

// ---------------------------------------------------------------- rule form

export const MAX_RULE_NAME = 128;
export const MAX_RULE_DESCRIPTION = 1024;
export const MAX_ENVIRONMENT = 64;
export const MAX_RULE_CHANNELS = 20;
/** Window, frequency and delays are entered in whole minutes, at most a day. */
export const MAX_MINUTES = 1440;

/** What the rule editor holds: numbers as typed, so a half-typed value is never lost. */
export interface RuleDraft {
  app_id: string;
  environment: string;
  name: string;
  description: string;
  metric: AlertMetric;
  condition: AlertCondition;
  threshold: string;
  window_min: string;
  schedule: "every" | "cron";
  every_min: string;
  cron: string;
  notify_after_min: string;
  resolve_after_min: string;
  consumer: string;
  group: string;
  endpoint: string;
  channel_ids: string[];
  enabled: boolean;
}

export type RuleField = keyof RuleDraft;
export type RuleErrors = Partial<Record<RuleField, string>>;

const minutes = (seconds: number | null | undefined) => (seconds ? String(Math.round(seconds / 60)) : "0");

/** The threshold as the form shows it: error rate in percent, rounded off float noise. */
function thresholdField(metric: AlertMetric, threshold: number): string {
  const v = unitOf(metric) === "rate" ? threshold * 100 : threshold;
  return String(Number(v.toFixed(6)));
}

/** A new rule's defaults: error rate above 5% over 5 minutes, checked every minute. */
export function newRuleDraft(appId = "", environment = ""): RuleDraft {
  return {
    app_id: appId,
    environment,
    name: "",
    description: "",
    ...withMetric({ metric: "error_rate", condition: "gt", threshold: "" }, "error_rate", false),
    window_min: "5",
    schedule: "every",
    every_min: "1",
    cron: "",
    notify_after_min: "0",
    resolve_after_min: "5",
    consumer: "",
    group: "",
    endpoint: "",
    channel_ids: [],
    enabled: true,
  };
}

/**
 * The draft with `metric` picked. Unless the user has typed a threshold (`thresholdTouched`), the
 * metric's default condition and threshold come with it (#982).
 */
export function withMetric<D extends Pick<RuleDraft, "metric" | "condition" | "threshold">>(draft: D, metric: AlertMetric, thresholdTouched: boolean): D {
  const m = METRICS.find((x) => x.value === metric);
  if (thresholdTouched || !m) return { ...draft, metric };
  return { ...draft, metric, condition: m.defaultCondition, threshold: thresholdField(metric, m.defaultThreshold) };
}

/** The draft's threshold in API units (rates 0..1), or null while it is not a number of 0 or more. */
export function draftThreshold(d: Pick<RuleDraft, "metric" | "threshold">): number | null {
  const raw = d.threshold.trim();
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n) || n < 0) return null;
  return unitOf(d.metric) === "rate" ? n / 100 : n;
}

/**
 * The one-line summary of a draft, which a new rule's name follows until the user types one
 * (#982): `Error rate (4xx + 5xx) > 5.0% over 5 min`. Empty while the threshold or the window is
 * not a number.
 */
export function draftSummary(d: Pick<RuleDraft, "metric" | "condition" | "threshold" | "window_min">): string {
  const threshold = draftThreshold(d);
  const window = wholeMinutes(d.window_min, 1);
  if (threshold === null || window === null) return "";
  return ruleSummary({ metric: d.metric, condition: d.condition, threshold, window_s: window * 60 }).slice(0, MAX_RULE_NAME);
}

/** The editor's draft of a saved rule. */
export function ruleDraftOf(rule: AlertRule): RuleDraft {
  return {
    app_id: rule.app_id,
    environment: rule.environment,
    name: rule.name,
    description: rule.description ?? "",
    metric: rule.metric,
    condition: rule.condition,
    threshold: thresholdField(rule.metric, rule.threshold),
    window_min: minutes(rule.window_s),
    schedule: rule.cron ? "cron" : "every",
    every_min: rule.cron ? "1" : minutes(rule.every_s ?? 60),
    cron: rule.cron ?? "",
    notify_after_min: minutes(rule.notify_after_s),
    resolve_after_min: minutes(rule.resolve_after_s),
    consumer: rule.filters?.consumer ?? "",
    group: rule.filters?.group ?? "",
    endpoint: rule.filters?.endpoint ?? "",
    channel_ids: rule.channel_ids ?? [],
    enabled: rule.enabled,
  };
}

/** Whole minutes in `min..MAX_MINUTES`, or null. */
function wholeMinutes(raw: string, min: number): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= MAX_MINUTES ? n : null;
}

const CRON_DESCRIPTORS = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);
const CRON_FIELD = /^[\d*,/\-A-Za-z?]+$/;

/** Five cron fields or a descriptor such as `@hourly`; the API parses it exactly. */
export function isCron(raw: string): boolean {
  const t = raw.trim();
  if (t === "" || t.length > 128) return false;
  if (t.startsWith("@")) return CRON_DESCRIPTORS.has(t.toLowerCase());
  const fields = t.split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

const ENDPOINT = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) )?\/\S*$/;

export type RuleCheck = { ok: true; body: AlertRuleBody } | { ok: false; errors: RuleErrors };

/** Checks the editor's draft as the API would and builds the request body. */
export function checkRuleDraft(d: RuleDraft): RuleCheck {
  const errors: RuleErrors = {};
  const name = d.name.trim();
  if (name === "" || name.length > MAX_RULE_NAME) errors.name = `Use a name of 1 to ${MAX_RULE_NAME} characters.`;
  const description = d.description.trim();
  if (description.length > MAX_RULE_DESCRIPTION) errors.description = `Keep the description under ${MAX_RULE_DESCRIPTION} characters.`;
  if (d.app_id === "") errors.app_id = "Pick the app whose requests the rule counts.";
  const environment = d.environment.trim();
  if (environment === "" || environment.length > MAX_ENVIRONMENT) errors.environment = `Enter an environment, such as production (at most ${MAX_ENVIRONMENT} characters).`;

  const unit = unitOf(d.metric);
  const raw = d.threshold.trim();
  let threshold = Number(raw);
  if (raw === "" || !Number.isFinite(threshold) || threshold < 0) {
    errors.threshold = "Enter a number of 0 or more.";
  } else if (unit === "rate" || unit === "pct") {
    if (threshold > 100) errors.threshold = "Enter a percentage from 0 to 100.";
    if (unit === "rate") threshold /= 100;
  } else if (unit === "score" && threshold > 1) {
    errors.threshold = "Apdex runs from 0 to 1.";
  }

  const window = wholeMinutes(d.window_min, 1);
  if (window === null) errors.window_min = `Enter whole minutes from 1 to ${MAX_MINUTES}.`;
  let every: number | null = null;
  let cron = "";
  if (d.schedule === "every") {
    every = wholeMinutes(d.every_min, 1);
    if (every === null) errors.every_min = `Enter whole minutes from 1 to ${MAX_MINUTES}.`;
  } else {
    cron = d.cron.trim();
    if (!isCron(cron)) errors.cron = "Enter five cron fields (minute hour day month weekday), such as */5 * * * *.";
  }
  const notify = wholeMinutes(d.notify_after_min, 0);
  if (notify === null) errors.notify_after_min = `Enter whole minutes from 0 to ${MAX_MINUTES}.`;
  const resolve = wholeMinutes(d.resolve_after_min, 0);
  if (resolve === null) errors.resolve_after_min = `Enter whole minutes from 0 to ${MAX_MINUTES}.`;

  const consumer = d.consumer.trim();
  if (consumer.length > 256) errors.consumer = "Use a consumer id of at most 256 characters.";
  const group = d.group.trim();
  if (group.length > 256) errors.group = "Use a group name of at most 256 characters.";
  const endpoint = d.endpoint.trim();
  if (endpoint !== "" && (endpoint.length > 512 || !ENDPOINT.test(endpoint))) errors.endpoint = "Use a route such as GET /orders/{id}, or /orders/{id} for every method.";
  if (d.channel_ids.length > MAX_RULE_CHANNELS) errors.channel_ids = `Pick at most ${MAX_RULE_CHANNELS} channels.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  // Resource metrics take no filters (the API refuses them), so any typed before a switch are dropped.
  const filters = isResourceMetric(d.metric) ? {} : { ...(consumer ? { consumer } : {}), ...(group ? { group } : {}), ...(endpoint ? { endpoint } : {}) };
  const body: AlertRuleBody = {
    environment,
    name,
    description,
    metric: d.metric,
    condition: d.condition,
    threshold,
    window_s: (window as number) * 60,
    ...(d.schedule === "every" ? { every_s: (every as number) * 60 } : { cron }),
    notify_after_s: (notify as number) * 60,
    resolve_after_s: (resolve as number) * 60,
    filters,
    channel_ids: d.channel_ids,
    enabled: d.enabled,
  };
  return { ok: true, body };
}

// ---------------------------------------------------------------- channels

export const CHANNEL_TYPES: { value: ChannelType; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "slack", label: "Slack" },
  { value: "teams", label: "Microsoft Teams" },
  { value: "webhook", label: "Webhook" },
];
export const channelTypeLabel = (t: ChannelType): string => CHANNEL_TYPES.find((c) => c.value === t)?.label ?? t;

export const MAX_CHANNEL_NAME = 128;
export const MAX_EMAIL_ADDRESSES = 20;
export const MIN_WEBHOOK_SECRET = 16;

/** What the channel form holds; only the fields of `type` are read. */
export interface ChannelDraft {
  type: ChannelType;
  name: string;
  addresses: string;
  webhook_url: string;
  url: string;
  secret: string;
}

export type ChannelField = keyof ChannelDraft;
export type ChannelErrors = Partial<Record<ChannelField, string>>;

export const newChannelDraft = (type: ChannelType = "email"): ChannelDraft => ({ type, name: "", addresses: "", webhook_url: "", url: "", secret: "" });

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** An https URL without credentials or a fragment, as the API requires. */
export function isHookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname !== "" && !u.username && !u.password && !raw.includes("#");
}

/** The addresses of the email field: split on commas, semicolons, spaces and lines. */
export const splitAddresses = (raw: string): string[] => raw.split(/[\s,;]+/).filter(Boolean);

export type ChannelCheck = { ok: true; name: string; config?: ChannelConfig } | { ok: false; errors: ChannelErrors };

/**
 * Checks the channel form. A saved channel's config is never shown again, so on an edit
 * (`editing`) blank config fields keep the saved config; anything typed replaces it whole.
 */
export function checkChannelDraft(d: ChannelDraft, editing = false): ChannelCheck {
  const errors: ChannelErrors = {};
  const name = d.name.trim();
  if (name === "" || name.length > MAX_CHANNEL_NAME) errors.name = `Use a name of 1 to ${MAX_CHANNEL_NAME} characters.`;
  let config: ChannelConfig | undefined;
  if (d.type === "email") {
    const addresses = splitAddresses(d.addresses);
    if (!(editing && addresses.length === 0)) {
      if (addresses.length === 0) errors.addresses = "Enter at least one email address.";
      else if (addresses.length > MAX_EMAIL_ADDRESSES) errors.addresses = `Enter at most ${MAX_EMAIL_ADDRESSES} addresses.`;
      else if (addresses.some((a) => !EMAIL.test(a))) errors.addresses = `Check ${addresses.find((a) => !EMAIL.test(a))}: it is not an email address.`;
      else config = { addresses };
    }
  } else if (d.type === "slack" || d.type === "teams") {
    const hook = d.webhook_url.trim();
    if (!(editing && hook === "")) {
      if (!isHookUrl(hook)) errors.webhook_url = "Paste the incoming webhook URL; it starts with https://.";
      else config = { webhook_url: hook };
    }
  } else {
    const url = d.url.trim();
    const secret = d.secret;
    if (!(editing && url === "" && secret === "")) {
      if (!isHookUrl(url)) errors.url = "Enter an https URL without credentials or a #fragment.";
      if (secret.length < MIN_WEBHOOK_SECRET) errors.secret = `Use a signing secret of at least ${MIN_WEBHOOK_SECRET} characters.`;
      if (!errors.url && !errors.secret) config = { url, secret };
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, name, ...(config ? { config } : {}) };
}

// ---------------------------------------------------------------- copy

/** The sentence a failed alert write shows, by error code. */
export function alertError(code: string | undefined, what: "rule" | "channel" = "rule"): string {
  switch (code) {
    case "conflict":
      return "This project already has a channel with that name.";
    case "validation_failed":
    case "bad_request":
    case "invalid_request":
      return what === "rule" ? "Some fields are not valid. Check the highlighted fields and try again." : "Check the channel details and try again.";
    case "forbidden":
      return "Only project admins can change alerts. Ask a project admin.";
    case "not_found":
      return what === "rule" ? "That rule no longer exists. Reload the page to see the current rules." : "That channel no longer exists. Reload the page to see the current channels.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

/**
 * The sentence a failed test notification shows. The API answers 502 when the channel refused it,
 * with only the failure class or the HTTP status in the detail (`... delivery failed: HTTP 404`).
 */
export function testError(status: number, code: string | undefined, detail?: string): string {
  if (status === 502) {
    const why = detail?.match(/delivery failed: (.+)$/)?.[1]?.trim();
    return `The channel didn’t accept the test notification${why ? ` (${why})` : ""}. Check its settings.`;
  }
  return alertError(code, "channel");
}

export const INCIDENTS_LOAD_FAILED = "We couldn’t load incidents just now.";
export const RULES_LOAD_FAILED = "We couldn’t load alert rules just now.";
export const CHANNELS_LOAD_FAILED = "We couldn’t load notification channels just now.";
export const READ_ONLY = "You can see alerts. Only project admins can change rules and channels.";
