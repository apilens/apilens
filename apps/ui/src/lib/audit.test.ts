import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUDIT_CATALOGUE,
  apiFilters,
  auditSentence,
  changedFields,
  decodeBound,
  encodeBound,
  exportFilters,
  fieldValue,
  groupFilters,
  offeredGroups,
  pageCut,
  parseActivityFilters,
  relativeTime,
  retentionText,
} from "./audit";
import type { AuditAction, AuditEvent } from "./identity";

const repoFile = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

/** Every `Kind` constant in internal/identity/audit/audit.go. */
const catalogued = () => [...repoFile("internal/identity/audit/audit.go").matchAll(/^\s+\w+\s+Kind = "([a-z_]+\.[a-z_]+)"/gm)].map((m) => m[1]);

const ev = (over: Partial<AuditEvent> & { time: string; id: string }): AuditEvent => ({
  action: "api_key.rotated",
  actor: { type: "user", id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", label: "Mina" },
  ip: "203.0.113.4",
  user_agent: "",
  request_id: "",
  target: { type: "api_key", id: "k1", label: "CI ingest" },
  changes: null,
  ...over,
});

const ACTIONS: AuditAction[] = [
  "member.added",
  "member.removed",
  "invitation.sent",
  "api_key.created",
  "api_key.rotated",
  "project.updated",
  "project.access_changed",
  "alert_rule.created",
  "health_check.created",
  "environment.added",
].map((action) => ({ action, label: action }));

describe("the audit catalogue", () => {
  it("has a sentence and a group for every catalogued action", () => {
    const kinds = catalogued();
    expect(kinds.length).toBeGreaterThan(40);
    expect(kinds.filter((k) => !AUDIT_CATALOGUE[k])).toEqual([]);
    expect(Object.keys(AUDIT_CATALOGUE).filter((k) => !kinds.includes(k))).toEqual([]);
    for (const k of kinds) {
      const s = auditSentence(ev({ id: "1", time: "2026-11-13T10:00:00Z", action: k }));
      expect(s, k).not.toContain(k);
      expect(s.length, k).toBeGreaterThan(5);
    }
  });

  it("reads an event as a sentence", () => {
    expect(auditSentence(ev({ id: "1", time: "2026-11-13T10:00:00Z" }))).toBe("Mina rotated key CI ingest");
    expect(
      auditSentence(ev({ id: "1", time: "2026-11-13T10:00:00Z", action: "project_member.role_changed", target: { type: "member", id: "m", label: "tom@example.com" }, changes: { previous: { role: "viewer" }, next: { role: "editor" } } })),
    ).toBe("Mina changed tom@example.com’s role to Editor");
    expect(auditSentence(ev({ id: "1", time: "2026-11-13T10:00:00Z", action: "project.access_changed", changes: { next: { default_access: "none" } } }))).toBe(
      "Mina set the project’s default access to restricted",
    );
    expect(auditSentence(ev({ id: "1", time: "2026-11-13T10:00:00Z", action: "api_key.expired", actor: { type: "system", label: "System" } }))).toBe("Key CI ingest expired");
    expect(auditSentence(ev({ id: "1", time: "2026-11-13T10:00:00Z", action: "thing.done" }))).toBe("Mina: thing.done on CI ingest");
  });
});

describe("groups", () => {
  it("offers only groups with actions, in order", () => {
    expect(offeredGroups(ACTIONS).map((g) => g.slug)).toEqual(["access", "keys", "settings", "environments", "alerts"]);
  });

  it("selects a group by noun prefixes, and by lone actions where a noun is split", () => {
    expect(groupFilters("keys", ACTIONS)).toEqual(["api_key."]);
    expect(groupFilters("access", ACTIONS)).toEqual(["member.", "invitation.", "project.access_changed"]);
    expect(groupFilters("settings", ACTIONS)).toEqual(["project.updated"]);
    expect(groupFilters("alerts", ACTIONS)).toEqual(["alert_rule.", "health_check."]);
    expect(groupFilters("data", ACTIONS)).toEqual([]);
  });
});

describe("URL filters", () => {
  it("reads valid filters and drops the rest", () => {
    expect(parseActivityFilters({ who: "1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D", group: "keys", from: "2026-11-01", to: "2026-11-13" })).toEqual({
      who: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      group: "keys",
      from: "2026-11-01",
      to: "2026-11-13",
    });
    expect(parseActivityFilters({ who: "ada", group: "x", from: "2026-13-45", to: "yesterday" })).toEqual({});
  });

  it("turns days into an RFC 3339 range and a group into one query per action filter", () => {
    expect(apiFilters({ from: "2026-11-01", to: "2026-11-30" }, ACTIONS)).toEqual([{ from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }]);
    expect(apiFilters({ group: "alerts", who: "u" }, ACTIONS)).toEqual([
      { actor: "u", action: "alert_rule." },
      { actor: "u", action: "health_check." },
    ]);
  });

  it("exports only what one action filter holds", () => {
    expect(exportFilters({ group: "keys" }, ACTIONS)).toEqual({ action: "api_key." });
    expect(exportFilters({}, ACTIONS)).toEqual({});
    expect(exportFilters({ group: "alerts" }, ACTIONS)).toBeNull();
  });
});

describe("paging", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 10, 0, s)).toISOString();

  it("round-trips the bound cursor", () => {
    const t = "2026-11-13T10:00:00.123456Z";
    expect(decodeBound(encodeBound(t))).toBe(t);
    expect(encodeBound(t)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBound("bm9wZQ")).toBeUndefined();
    expect(decodeBound(undefined)).toBeUndefined();
  });

  it("shows one answer's page and bounds the next by its oldest time", () => {
    const events = [50, 40, 30].map((s, i) => ev({ id: String(10 - i), time: at(s) }));
    expect(pageCut([{ events, more: true }], 3)).toEqual({ events: events.slice(0, 2), next: at(40) });
    expect(pageCut([{ events, more: false }], 3)).toEqual({ events, next: null });
  });

  it("merges several answers newest first without showing what an answer may still hold", () => {
    const a = [ev({ id: "9", time: at(59) }), ev({ id: "7", time: at(30) })];
    const b = [ev({ id: "8", time: at(45) }), ev({ id: "6", time: at(10) })];
    // a has more (at or before :30), b does not: :59 and :45 are complete; :30 waits for the next page.
    const { events, next } = pageCut([{ events: a, more: true }, { events: b, more: false }], 2);
    expect(events.map((e) => e.id)).toEqual(["9", "8"]);
    expect(next).toBe(at(45));
  });

  it("never splits one time across pages", () => {
    const events = [ev({ id: "5", time: at(50) }), ev({ id: "4", time: at(40) }), ev({ id: "3", time: at(40) })];
    expect(pageCut([{ events, more: false }], 2)).toEqual({ events: events.slice(0, 1), next: at(50) });
  });

  it("drops duplicates", () => {
    const e = ev({ id: "1", time: at(1) });
    expect(pageCut([{ events: [e], more: false }, { events: [e], more: false }], 5).events).toHaveLength(1);
  });
});

describe("detail", () => {
  it("lists only the fields that changed", () => {
    expect(changedFields({ previous: { role: "viewer", name: "x" }, next: { role: "editor", name: "x", extra: 1 } })).toEqual([
      { field: "role", before: "viewer", after: "editor" },
      { field: "extra", before: undefined, after: 1 },
    ]);
    expect(changedFields(null)).toEqual([]);
    expect(fieldValue(undefined)).toBe("–");
    expect(fieldValue(["a"])).toBe('["a"]');
  });

  it("says how far back the log goes", () => {
    expect(retentionText(400)).toBe("The activity log goes back 400 days; older events are deleted.");
    expect(retentionText(0)).toBe("The activity log keeps every event for as long as the project exists.");
  });

  it("writes relative times", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(relativeTime("2026-11-13T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-11-13T11:20:00Z", now)).toBe("40 min ago");
    expect(relativeTime("2026-11-13T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-11-11T12:00:00Z", now)).toBe("2 days ago");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("2026-09-01");
  });
});
