// The access, audit and key types of identity.ts (#804) against api/openapi/apilens.v1.json: each
// fixture below is typed with every field set, so TypeScript rejects a field the type lacks and
// this test rejects a field the spec lacks or the spec requires that the type leaves out.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  AccessMember,
  AccessSource,
  ApiKey,
  AuditAction,
  AuditActor,
  AuditEvent,
  AuditEvents,
  AuditTarget,
  DefaultAccessChange,
  Invitation,
  InvitationProjectGrant,
  KeyCreator,
  ProjectAccess,
  RotatedApiKey,
} from "./identity";

vi.mock("server-only", () => ({}));

interface Schema {
  properties?: Record<string, unknown>;
  required?: string[];
}
const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../api/openapi/apilens.v1.json", import.meta.url)), "utf8"),
) as { components: { schemas: Record<string, Schema> } };

const T = "2026-11-13T10:00:00Z";
const ID = "3f0e8c1a-2b4d-4e6f-8a1b-2c3d4e5f6a7b";

const source: Required<AccessSource> = { kind: "default", role: "editor", org_role: "member" };
const member: Required<AccessMember> = {
  user_id: ID,
  name: "Max Member",
  email: "max@example.com",
  avatar_initials: "MM",
  effective_role: "editor",
  sources: [source],
  direct_role: null,
  added_at: T,
  added_by: { id: ID, name: "Ada Admin" },
  last_active_at: null,
};
const access: Required<ProjectAccess> = { default_access: "org_role", members: [member], next_cursor: "" };
const change: Required<DefaultAccessChange> = { default_access: "none", previous_default_access: "org_role", lose_access: 3, dry_run: false };
const actor: Required<AuditActor> = { type: "user", id: ID, label: "Ada Admin" };
const target: Required<AuditTarget> = { type: "api_key", id: ID, label: "Production backend" };
const event: Required<AuditEvent> = {
  id: "1",
  time: T,
  action: "api_key.created",
  actor,
  ip: "203.0.113.7",
  user_agent: "Mozilla/5.0",
  request_id: "req_1",
  target,
  project: { slug: "shop", name: "Shop" },
  changes: null,
};
const events: Required<AuditEvents> = { events: [event], next_cursor: "", retention_days: 400 };
const action: Required<AuditAction> = { action: "api_key.created", label: "API key created" };
const creator: Required<KeyCreator> = { id: ID, name: "Ada Admin" };
const key: Required<ApiKey> = {
  id: ID,
  name: "Production backend",
  prefix: "apl_live_Q2x9aZ1",
  scopes: ["ingest"],
  can_create_apps: true,
  app_ids: null,
  apps_seen: [],
  last_used_at: T,
  created_at: T,
  expires_at: null,
  revoked_at: null,
  created_by: creator,
  environments: ["production"],
  last_used_ip: "203.0.113.7",
  last_used_sdk: "apilenss/0.5.0",
  rate_limit_per_minute: null,
  rotated_from: null,
  rotated_to: null,
};
const rotated: Required<RotatedApiKey> = { ...key, key: "apl_live_secret", previous: key };
const grant: Required<InvitationProjectGrant> = { project_id: ID, project: "shop", project_name: "Shop", role: "viewer" };
const invitation: Required<Invitation> = {
  id: ID,
  email: "new.dev@example.com",
  role: "member",
  created_at: T,
  expires_at: T,
  resent_at: null,
  invited_by: { id: ID, email: "ada@example.com", name: "Ada Admin" },
  project_grants: [grant],
};

const cases: [string, object][] = [
  ["AccessSource", source],
  ["AccessMember", member],
  ["ListProjectAccessOutputBody", access],
  ["SetDefaultAccessOutputBody", change],
  ["AuditActor", actor],
  ["AuditTarget", target],
  ["AuditEvent", event],
  ["ListAuditEventsOutputBody", events],
  ["AuditAction", action],
  ["KeyCreator", creator],
  ["APIKey", key],
  ["RotatedAPIKey", rotated],
  ["InvitationProjectGrant", grant],
  ["Invitation", invitation],
];

describe("access, audit and key types match the committed OpenAPI spec", () => {
  it.each(cases)("%s", (name, fixture) => {
    const schema = spec.components.schemas[name];
    expect(schema, `${name} is not in the spec`).toBeDefined();
    const props = Object.keys(schema.properties ?? {}).filter((p) => p !== "$schema").sort();
    expect(Object.keys(fixture).sort()).toEqual(props);
  });
});
