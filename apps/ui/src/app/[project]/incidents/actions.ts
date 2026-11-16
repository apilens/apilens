"use server";

// Server Actions of the alerts pages (#610): create, change and delete alert rules and
// notification channels, and send a test notification. Each re-checks its input (a Server Action
// is a public POST endpoint) with the same checks the forms run, calls the API as the signed-in
// user and answers a sentence to show, never a raw error. Authorization is the API's
// (`project#manage_alerts`); the UI only hides what the user can't do.
import { type ChannelDraft, type RuleDraft, type RuleErrors, alertError, checkChannelDraft, checkRuleDraft, testError } from "@/lib/alerts";
import { isProjectSlug } from "@/lib/api-keys";
import { type AlertMetric, type AlertCondition, type ChannelType, identity, isApiError } from "@/lib/identity";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type AlertActionResult = { ok: true; id?: string } | { ok: false; error: string; code?: string; errors?: RuleErrors | Record<string, string> };

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
const str = (v: unknown, max = 2048) => (typeof v === "string" ? v.slice(0, max) : "");
const METRICS: AlertMetric[] = ["traffic", "errors", "error_rate", "p50", "p75", "p95", "apdex", "unique_consumers"];
const CONDITIONS: AlertCondition[] = ["gt", "gte", "lt", "lte"];
const TYPES: ChannelType[] = ["email", "slack", "teams", "webhook"];

/** The rule draft a client sent, coerced field by field; anything unexpected reads as blank. */
function ruleDraft(v: unknown): RuleDraft {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  return {
    app_id: str(o.app_id, 64),
    environment: str(o.environment),
    name: str(o.name),
    description: str(o.description),
    metric: METRICS.includes(o.metric as AlertMetric) ? (o.metric as AlertMetric) : "error_rate",
    condition: CONDITIONS.includes(o.condition as AlertCondition) ? (o.condition as AlertCondition) : "gt",
    threshold: str(o.threshold, 64),
    window_min: str(o.window_min, 16),
    schedule: o.schedule === "cron" ? "cron" : "every",
    every_min: str(o.every_min, 16),
    cron: str(o.cron, 256),
    notify_after_min: str(o.notify_after_min, 16),
    resolve_after_min: str(o.resolve_after_min, 16),
    consumer: str(o.consumer, 1024),
    group: str(o.group, 1024),
    endpoint: str(o.endpoint),
    channel_ids: Array.isArray(o.channel_ids) ? o.channel_ids.filter(isId).slice(0, 64) : [],
    enabled: o.enabled !== false,
  };
}

function channelDraft(v: unknown): ChannelDraft {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  return {
    type: TYPES.includes(o.type as ChannelType) ? (o.type as ChannelType) : "email",
    name: str(o.name),
    addresses: str(o.addresses, 8192),
    webhook_url: str(o.webhook_url),
    url: str(o.url),
    secret: str(o.secret, 1024),
  };
}

async function run(project: unknown, what: "rule" | "channel", fn: (s: ServerSession, project: string) => Promise<string | undefined | void>): Promise<AlertActionResult> {
  if (!isProjectSlug(project)) return { ok: false, error: alertError("not_found", what), code: "not_found" };
  return withActionSession(async (session) => {
    try {
      const id = await fn(session, project);
      return id ? { ok: true, id } : { ok: true };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: alertError(err.code, what), code: err.code };
    }
  });
}

const invalid = (errors: Record<string, string>, what: "rule" | "channel"): AlertActionResult => ({
  ok: false,
  error: alertError("invalid_request", what),
  code: "invalid_request",
  errors,
});

export async function createAlertRule(project: string, draft: unknown): Promise<AlertActionResult> {
  const d = ruleDraft(draft);
  const checked = checkRuleDraft(d);
  if (!checked.ok) return invalid(checked.errors as Record<string, string>, "rule");
  return run(project, "rule", async (s, p) => (await s.call((o) => identity().createAlertRule(p, { ...checked.body, app_id: d.app_id }, o))).id);
}

export async function updateAlertRule(project: string, id: unknown, draft: unknown): Promise<AlertActionResult> {
  if (!isId(id)) return { ok: false, error: alertError("not_found"), code: "not_found" };
  const checked = checkRuleDraft(ruleDraft(draft));
  if (!checked.ok) return invalid(checked.errors as Record<string, string>, "rule");
  return run(project, "rule", async (s, p) => {
    await s.call((o) => identity().updateAlertRule(p, id, checked.body, o));
    return id;
  });
}

export async function deleteAlertRule(project: string, id: unknown): Promise<AlertActionResult> {
  if (!isId(id)) return { ok: false, error: alertError("not_found"), code: "not_found" };
  return run(project, "rule", async (s, p) => {
    await s.call((o) => identity().deleteAlertRule(p, id, o));
  });
}

export async function createChannel(project: string, draft: unknown): Promise<AlertActionResult> {
  const d = channelDraft(draft);
  const checked = checkChannelDraft(d);
  if (!checked.ok) return invalid(checked.errors as Record<string, string>, "channel");
  const config = checked.config;
  if (!config) return invalid({}, "channel");
  return run(project, "channel", async (s, p) => (await s.call((o) => identity().createChannel(p, { type: d.type, name: checked.name, config }, o))).id);
}

/** Renames a channel; config fields left blank keep its saved config. */
export async function updateChannel(project: string, id: unknown, draft: unknown): Promise<AlertActionResult> {
  if (!isId(id)) return { ok: false, error: alertError("not_found", "channel"), code: "not_found" };
  const checked = checkChannelDraft(channelDraft(draft), true);
  if (!checked.ok) return invalid(checked.errors as Record<string, string>, "channel");
  return run(project, "channel", async (s, p) => {
    await s.call((o) => identity().updateChannel(p, id, checked.config ? { name: checked.name, config: checked.config } : { name: checked.name }, o));
    return id;
  });
}

export async function deleteChannel(project: string, id: unknown): Promise<AlertActionResult> {
  if (!isId(id)) return { ok: false, error: alertError("not_found", "channel"), code: "not_found" };
  return run(project, "channel", async (s, p) => {
    await s.call((o) => identity().deleteChannel(p, id, o));
  });
}

/** Sends a test notification through a channel now; a refusal answers what the channel said. */
export async function testChannel(project: string, id: unknown): Promise<AlertActionResult> {
  if (!isId(id)) return { ok: false, error: alertError("not_found", "channel"), code: "not_found" };
  if (!isProjectSlug(project)) return { ok: false, error: alertError("not_found", "channel"), code: "not_found" };
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().testChannel(project, id, o));
      return { ok: true };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: testError(err.status, err.code, err.problem?.detail), code: err.code };
    }
  });
}
