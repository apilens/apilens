// The project activity log (Access › Activity, #812): each audited action as a sentence and an
// action group, the filters in the URL, and the paging. Pure; safe in Client Components.
//
// The audit API filters by one action, or one `noun.` prefix (internal/identity/audit/list.go). A
// group (Access, API keys, ...) spans several nouns, so a page of a group is read as one call per
// noun (or lone action) with the same `to` bound, merged newest first. Paging therefore walks a
// time bound instead of the API's cursor: the next page holds the events at or before the oldest
// time the current page did not finish (`pageCut`). Unit-tested in audit.test.ts.

import type { AuditAction, AuditEvent, AuditFilters, AuditScope } from "./identity";
import type { ParamsInput } from "./pagination";

/** The action groups offered as a filter, in order. */
export const AUDIT_GROUPS = [
  { slug: "access", label: "Access" },
  { slug: "keys", label: "API keys" },
  { slug: "settings", label: "Settings" },
  { slug: "environments", label: "Environments" },
  { slug: "alerts", label: "Alerts" },
  { slug: "data", label: "Data" },
] as const;

export type AuditGroup = (typeof AUDIT_GROUPS)[number]["slug"];

/** How an event reads: `who` is the actor's name, `what` the target's label. */
type Sentence = (who: string, what: string, e: AuditEvent) => string;

const ROLE_LABELS: Record<string, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer", owner: "Owner", member: "Member" };
const DEFAULT_ACCESS_LABELS: Record<string, string> = { org_role: "organization role", viewer: "view only", none: "restricted" };

const nextField = (e: AuditEvent, field: string): unknown => e.changes?.next?.[field];
const roleText = (v: unknown) => (typeof v === "string" ? (ROLE_LABELS[v] ?? v) : "");

/** `verb` the target: "Ada rotated key CI ingest". */
const did = (verb: string, noun = ""): Sentence => (who, what) => `${who} ${verb}${noun ? ` ${noun}` : ""}${what ? ` ${what}` : ""}`;
/** Something the actor did to themselves: "Ada signed in". */
const self = (text: string): Sentence => (who) => `${who} ${text}`;

const roleChange: Sentence = (who, what, e) => {
  const role = roleText(nextField(e, "role"));
  return role ? `${who} changed ${what || "a member"}’s role to ${role}` : `${who} changed ${what || "a member"}’s role`;
};

/**
 * Every action in the audit catalogue (`Kind` in internal/identity/audit/audit.go), with its
 * group and sentence. A test checks that the catalogue and this table list the same actions.
 */
export const AUDIT_CATALOGUE: Record<string, { group: AuditGroup; sentence: Sentence }> = {
  // The account's own security events: never on a project log, kept so every action reads.
  "user.created": { group: "access", sentence: self("created an account") },
  "user.updated": { group: "access", sentence: self("updated their profile") },
  "user.deleted": { group: "access", sentence: self("deleted their account") },
  "user.restored": { group: "access", sentence: self("restored their account") },
  "login.succeeded": { group: "access", sentence: self("signed in") },
  "login.failed": { group: "access", sentence: self("failed to sign in") },
  "login.requested": { group: "access", sentence: self("asked for a sign-in code") },
  "session.revoked": { group: "access", sentence: self("signed out a session") },
  "session.reuse_detected": { group: "access", sentence: () => "A reused session token was detected and the session ended" },
  "session.reauthenticated": { group: "access", sentence: self("confirmed their identity") },
  "session.reauth_failed": { group: "access", sentence: self("failed to confirm their identity") },
  "email.changed": { group: "access", sentence: self("changed their email address") },
  "passkey.added": { group: "access", sentence: did("added passkey") },
  "passkey.removed": { group: "access", sentence: did("removed passkey") },
  "passkey.renamed": { group: "access", sentence: did("renamed passkey") },
  "totp.enabled": { group: "access", sentence: self("turned on two-factor authentication") },
  "totp.disabled": { group: "access", sentence: self("turned off two-factor authentication") },
  "recovery.requested": { group: "access", sentence: self("asked to recover their account") },
  "recovery.confirmed": { group: "access", sentence: self("recovered their account") },
  "recovery.cancelled": { group: "access", sentence: self("cancelled an account recovery") },
  "oauth.linked": { group: "access", sentence: did("connected", "account") },
  "oauth.unlinked": { group: "access", sentence: did("disconnected", "account") },

  // Who may do what.
  "member.added": { group: "access", sentence: did("added", "member") },
  "member.role_changed": { group: "access", sentence: roleChange },
  "member.removed": { group: "access", sentence: did("removed", "member") },
  "member.joined": { group: "access", sentence: (who, what) => `${what || who} joined the organization` },
  "invitation.sent": { group: "access", sentence: did("invited") },
  "invitation.accepted": { group: "access", sentence: (who, what) => `${what || who} accepted an invitation` },
  "invitation.revoked": { group: "access", sentence: did("revoked the invitation for") },
  "project_member.added": {
    group: "access",
    sentence: (who, what, e) => {
      const role = roleText(nextField(e, "role"));
      return `${who} added ${what || "a member"} to the project${role ? ` as ${role}` : ""}`;
    },
  },
  "project_member.role_changed": { group: "access", sentence: roleChange },
  "project_member.removed": { group: "access", sentence: (who, what) => `${who} removed ${what || "a member"} from the project` },
  "project.access_changed": {
    group: "access",
    sentence: (who, _what, e) => {
      const next = nextField(e, "default_access");
      const label = typeof next === "string" ? DEFAULT_ACCESS_LABELS[next] : undefined;
      return label ? `${who} set the project’s default access to ${label}` : `${who} changed the project’s default access`;
    },
  },
  "sso.updated": { group: "access", sentence: did("updated the SSO connection") },
  "sso.deleted": { group: "access", sentence: did("deleted the SSO connection") },
  "audit_log.exported": { group: "access", sentence: self("exported the activity log") },

  "api_key.created": { group: "keys", sentence: did("created", "key") },
  "api_key.updated": { group: "keys", sentence: did("updated", "key") },
  "api_key.rotated": { group: "keys", sentence: did("rotated", "key") },
  "api_key.revoked": { group: "keys", sentence: did("revoked", "key") },
  "api_key.expired": { group: "keys", sentence: (_who, what) => `Key ${what || "(unnamed)"} expired` },

  "org.created": { group: "settings", sentence: did("created the organization") },
  "org.updated": { group: "settings", sentence: did("updated the organization settings") },
  "org.deleted": { group: "settings", sentence: did("deleted the organization") },
  "project.created": { group: "settings", sentence: did("created project") },
  "project.updated": { group: "settings", sentence: did("updated the settings of project") },
  "project.paused": { group: "settings", sentence: did("paused project") },
  "project.resumed": { group: "settings", sentence: did("resumed project") },
  "project.deleted": { group: "settings", sentence: did("scheduled the deletion of project") },
  "project.restored": { group: "settings", sentence: did("restored project") },
  "project.purged": { group: "settings", sentence: (_who, what) => `The data of project ${what || "(unnamed)"} was permanently deleted` },
  "project.slug_changed": {
    group: "settings",
    sentence: (who, what, e) => {
      const slug = nextField(e, "slug");
      return typeof slug === "string" ? `${who} renamed the URL of project ${what} to ${slug}` : `${who} renamed the URL of project ${what}`;
    },
  },

  "environment.added": { group: "environments", sentence: did("added", "environment") },
  "environment.updated": { group: "environments", sentence: did("updated", "environment") },
  "environment.removed": { group: "environments", sentence: did("removed", "environment") },

  "alert_rule.created": { group: "alerts", sentence: did("created", "alert rule") },
  "alert_rule.updated": { group: "alerts", sentence: did("updated", "alert rule") },
  "alert_rule.deleted": { group: "alerts", sentence: did("deleted", "alert rule") },
  "alert_channel.created": { group: "alerts", sentence: did("created", "alert channel") },
  "alert_channel.updated": { group: "alerts", sentence: did("updated", "alert channel") },
  "alert_channel.deleted": { group: "alerts", sentence: did("deleted", "alert channel") },
  "health_check.created": { group: "alerts", sentence: did("created", "health check") },
  "health_check.deleted": { group: "alerts", sentence: did("deleted", "health check") },

  "app.created": { group: "data", sentence: did("created", "app") },
  "app.renamed": { group: "data", sentence: did("renamed", "app") },
  "app.archived": { group: "data", sentence: did("archived", "app") },
  "app.restored": { group: "data", sentence: did("restored", "app") },
  "app.merged": { group: "data", sentence: did("merged", "app") },
  "app.deleted": { group: "data", sentence: did("deleted", "app") },
  "app.acknowledged": { group: "data", sentence: did("acknowledged", "app") },
  "app_settings.updated": { group: "data", sentence: did("updated the settings of app") },
  "endpoint_settings.updated": { group: "data", sentence: did("updated the settings of endpoint") },
  "capture_policy.updated": { group: "data", sentence: did("updated the capture policy of") },
  "privacy_policy.updated": { group: "data", sentence: did("updated the privacy policy of") },
};

/** Who did it, as a sentence starts: their name, "System", or "Someone" when unknown. */
export function actorName(e: AuditEvent): string {
  if (e.actor.type === "system") return e.actor.label || "System";
  return e.actor.label || "Someone";
}

/** "Ada Admin rotated key Production backend"; an action missing from the catalogue reads by its name. */
export function auditSentence(e: AuditEvent): string {
  const entry = AUDIT_CATALOGUE[e.action];
  const what = e.target?.label ?? "";
  if (entry) return entry.sentence(actorName(e), what, e);
  return `${actorName(e)}: ${e.action}${what ? ` on ${what}` : ""}`;
}

/** The group of an action; undefined for one the catalogue does not know. */
export function auditGroup(action: string): AuditGroup | undefined {
  return AUDIT_CATALOGUE[action]?.group;
}

export const isAuditGroup = (v: unknown): v is AuditGroup => AUDIT_GROUPS.some((g) => g.slug === v);

/** The group's label ("API keys"). */
export function groupLabel(group: AuditGroup): string {
  return AUDIT_GROUPS.find((g) => g.slug === group)?.label ?? group;
}

/** The groups that have at least one action in `actions` (the API's `auditActions`), in order. */
export function offeredGroups(actions: readonly AuditAction[]): (typeof AUDIT_GROUPS)[number][] {
  const present = new Set(actions.map((a) => auditGroup(a.action)));
  return AUDIT_GROUPS.filter((g) => present.has(g.slug));
}

/**
 * The API `action` filters that together select `group` among the offered `actions`: `noun.` when
 * every offered action of that noun is in the group, otherwise each action on its own.
 */
export function groupFilters(group: AuditGroup, actions: readonly AuditAction[]): string[] {
  const byNoun = new Map<string, string[]>();
  for (const { action } of actions) {
    const noun = action.slice(0, action.indexOf("."));
    byNoun.set(noun, [...(byNoun.get(noun) ?? []), action]);
  }
  const out: string[] = [];
  for (const [noun, list] of byNoun) {
    const inGroup = list.filter((a) => auditGroup(a) === group);
    if (inGroup.length === 0) continue;
    if (inGroup.length === list.length) out.push(`${noun}.`);
    else out.push(...inGroup);
  }
  return out;
}

// ---------------------------------------------------------------------------------- URL filters

/** The filters of the Activity tab as the URL holds them (`?who=&group=&from=&to=`, plus `project=` on the organization's audit log). */
export interface ActivityFilters {
  /** A person's user id. */
  who?: string;
  /** On the organization's audit log (#813): one project's slug. */
  project?: string;
  group?: AuditGroup;
  /** First day, `YYYY-MM-DD` (UTC). */
  from?: string;
  /** Last day, inclusive, `YYYY-MM-DD` (UTC). */
  to?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const isDay = (v: string | undefined): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const first = (params: ParamsInput, key: string): string | undefined => {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
};

/** Reads the filters; a malformed value is left out. */
export function parseActivityFilters(params: ParamsInput): ActivityFilters {
  const who = first(params, "who");
  const group = first(params, "group");
  const from = first(params, "from");
  const to = first(params, "to");
  const project = first(params, "project");
  return {
    ...(who && UUID.test(who) ? { who: who.toLowerCase() } : {}),
    ...(project && PROJECT_SLUG.test(project) ? { project } : {}),
    ...(isAuditGroup(group) ? { group } : {}),
    ...(isDay(from) ? { from } : {}),
    ...(isDay(to) ? { to } : {}),
  };
}

/** True when any filter is set. */
export const hasFilters = (f: ActivityFilters) => !!(f.who || f.project || f.group || f.from || f.to);

/** The query string of `f` (no `?`), for links and the export. */
export function filtersQuery(f: ActivityFilters): string {
  const p = new URLSearchParams();
  if (f.who) p.set("who", f.who);
  if (f.project) p.set("project", f.project);
  if (f.group) p.set("group", f.group);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  return p.toString();
}

/**
 * Where the organization's audit log (#813) reads: one project's log when the Project filter names
 * one of the organization's `projects`, otherwise the organization's (every project the caller can
 * view, plus its org-wide events). A project the list does not hold is dropped from the filters.
 */
export function orgAuditScope(org: string, f: ActivityFilters, projects: readonly string[]): { scope: AuditScope; filters: ActivityFilters } {
  if (f.project && projects.includes(f.project)) return { scope: { project: f.project }, filters: f };
  const { project: _, ...rest } = f;
  return { scope: { org }, filters: rest };
}

/** The day after `day` (`YYYY-MM-DD`). */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The API filters of `f`, one per `action` filter of its group (one, unfiltered by action, without
 * a group). Days become `from` at midnight UTC and `to` before the next midnight.
 */
export function apiFilters(f: ActivityFilters, actions: readonly AuditAction[]): AuditFilters[] {
  const base: AuditFilters = {
    ...(f.who ? { actor: f.who } : {}),
    ...(f.from ? { from: `${f.from}T00:00:00Z` } : {}),
    ...(f.to ? { to: `${nextDay(f.to)}T00:00:00Z` } : {}),
  };
  if (!f.group) return [base];
  return groupFilters(f.group, actions).map((action) => ({ ...base, action }));
}

/**
 * The CSV export's filters: the API exports one action filter at a time, so a group that needs
 * more than one has none (null).
 */
export function exportFilters(f: ActivityFilters, actions: readonly AuditAction[]): AuditFilters | null {
  const all = apiFilters(f, actions);
  return all.length === 1 ? all[0] : null;
}

// ------------------------------------------------------------------------------------- paging

/** The time-bound page cursor: base64url of the RFC 3339 `to` bound. */
export function encodeBound(time: string): string {
  return btoa(time).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The `to` bound of a page cursor, or undefined when it is not one. */
export function decodeBound(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  let s: string;
  try {
    s = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return undefined;
  }
  return RFC3339.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Nanoseconds since the epoch of an RFC 3339 time, exactly (Date only keeps milliseconds). */
function nanos(time: string): bigint {
  const m = RFC3339.exec(time);
  if (!m) return BigInt(Date.parse(time)) * 1_000_000n;
  const seconds = BigInt(Date.parse(`${m[1]}${m[3]}`)) / 1000n;
  return seconds * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
}

/** Newest first; equal times by id, larger (later) first. */
export function compareEvents(a: AuditEvent, b: AuditEvent): number {
  const d = nanos(b.time) - nanos(a.time);
  if (d !== 0n) return d > 0n ? 1 : -1;
  return b.id.localeCompare(a.id, "en", { numeric: true });
}

/** One API answer read for a page: its events (up to the limit asked) and whether it has more. */
export interface PagePart {
  events: readonly AuditEvent[];
  more: boolean;
}

/**
 * Merges the answers of one page (each asked for `limit` events before the same bound) into at
 * most `limit` newest events and the `to` bound of the next page (null on the last). An answer
 * with more may still hold unread events at its oldest time, so the page only shows events newer
 * than that, and never ends in the middle of a time: the next page, bounded by the oldest time
 * shown (exclusive), then neither repeats nor skips an event. Only when one time fills a whole
 * page does the page show it alone and move past it.
 */
export function pageCut(parts: readonly PagePart[], limit: number): { events: AuditEvent[]; next: string | null } {
  const seen = new Set<string>();
  const merged: AuditEvent[] = [];
  for (const p of parts)
    for (const e of p.events)
      if (!seen.has(e.id)) {
        seen.add(e.id);
        merged.push(e);
      }
  merged.sort(compareEvents);

  // The newest time an answer may still hold unread events at: the oldest it returned.
  let horizon: bigint | null = null;
  for (const p of parts) {
    if (!p.more || p.events.length === 0) continue;
    const oldest = p.events.reduce((m, e) => (nanos(e.time) < m ? nanos(e.time) : m), nanos(p.events[0].time));
    if (horizon === null || oldest > horizon) horizon = oldest;
  }
  const complete = horizon === null ? merged : merged.filter((e) => nanos(e.time) > horizon!);
  let shown = complete.slice(0, limit);
  const rest = merged.slice(shown.length);
  if (rest.length === 0) return { events: shown, next: null };
  const cutAt = nanos(rest[0].time);
  const whole = shown.filter((e) => nanos(e.time) > cutAt);
  shown = whole.length > 0 ? whole : merged.filter((e) => nanos(e.time) === cutAt).slice(0, Math.max(limit, 1));
  return { events: shown, next: shown[shown.length - 1].time };
}

// ------------------------------------------------------------------------------------- detail

/** One changed field of an event: its value before and after (undefined when absent). */
export interface ChangedField {
  field: string;
  before: unknown;
  after: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields whose value differs between `changes.previous` and `changes.next`, in order. */
export function changedFields(changes: AuditEvent["changes"]): ChangedField[] {
  if (!changes) return [];
  const prev = changes.previous ?? {};
  const next = changes.next ?? {};
  const fields = [...new Set([...Object.keys(prev), ...Object.keys(next)])];
  return fields.filter((f) => !same(prev[f], next[f])).map((field) => ({ field, before: prev[field], after: next[field] }));
}

/** A value of a changed field as text: strings as they are, the rest as JSON; "–" when absent. */
export function fieldValue(v: unknown): string {
  if (v === undefined) return "–";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** "Changes go back 400 days." / "Changes are kept for as long as the project exists." */
export function retentionText(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "The activity log keeps every event for as long as the project exists.";
  return `The activity log goes back ${days} day${days === 1 ? "" : "s"}; older events are deleted.`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(t).toISOString().slice(0, 10);
}
