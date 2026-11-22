"use server";

// Server Actions of the notification channels (#610, Project settings › Alerts): create, change
// and delete a channel, and send a test notification. Each re-checks its input (a Server Action is
// a public POST endpoint) with the same checks the form runs, calls the API as the signed-in user
// and answers a sentence to show, never a raw error. Authorization is the API's
// (`project#manage_alerts`); the UI only hides what the user can't do.
import { type ChannelDraft, alertError, checkChannelDraft, testError } from "@/lib/alerts";
import { isProjectSlug } from "@/lib/api-keys";
import { type ChannelType, identity, isApiError } from "@/lib/identity";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type AlertActionResult = { ok: true; id?: string } | { ok: false; error: string; code?: string; errors?: Record<string, string> };

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
const str = (v: unknown, max = 2048) => (typeof v === "string" ? v.slice(0, max) : "");
const TYPES: ChannelType[] = ["email", "slack", "teams", "webhook"];

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

async function run(project: unknown, what: "channel", fn: (s: ServerSession, project: string) => Promise<string | undefined | void>): Promise<AlertActionResult> {
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

const invalid = (errors: Record<string, string>, what: "channel"): AlertActionResult => ({
  ok: false,
  error: alertError("invalid_request", what),
  code: "invalid_request",
  errors,
});


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
