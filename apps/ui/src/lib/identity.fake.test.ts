// The access, audit and key rotation client methods (#804) against the fake identity
// (e2e-fake/fake-identity.ts), started here on its own port: each method hits its fake route and
// the measured seed answers. No email is sent, no real backend is involved.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type IdentityClient, createClient } from "./identity";

const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = ["project.read", "project.update", "api_keys.create", "api_keys.revoke", "access.manage", "audit.read"];

let server: ChildProcess;
let client: IdentityClient;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Signs in a fresh fake user (owner of acme) and answers their access token. */
async function signIn(seed: Record<string, unknown> = {}): Promise<{ accessToken: string; userId: string }> {
  const { code } = (await (await post("/__fake/handoff", { next: "/", capabilities: ADMIN, ...seed })).json()) as { code: string };
  const bundle = await client.handoff({ code });
  if (!("access_token" in bundle)) throw new Error("expected a session bundle");
  return { accessToken: bundle.access_token, userId: bundle.user.id };
}

beforeAll(async () => {
  server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("../../e2e-fake/fake-identity.ts", import.meta.url))], {
    env: { ...process.env, FAKE_IDENTITY_PORT: String(PORT), FAKE_IDENTITY_UI_URL: "http://localhost:3999" },
    stdio: "ignore",
  });
  client = createClient({ baseUrl: BASE });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("fake identity did not start");
}, 15_000);

afterAll(() => {
  server?.kill();
});

beforeEach(async () => {
  await post("/__fake/access", {});
  await post("/__fake/audit", {});
});

describe("project access", () => {
  it("lists nine people with mixed sources, the signed-in user among them", async () => {
    const me = await signIn();
    const page = await client.projectAccess("shop", {}, me);
    expect(page.default_access).toBe("org_role");
    expect(page.next_cursor).toBe("");
    const members = page.members ?? [];
    expect(members).toHaveLength(9);
    expect(members.map((m) => m.email)).toEqual([...members.map((m) => m.email)].sort());
    expect(members.find((m) => m.email === "you@example.com")?.user_id).toBe(me.userId);
    const kinds = new Set(members.flatMap((m) => (m.sources ?? []).map((s) => s.kind)));
    expect(kinds).toEqual(new Set(["org_role", "default", "direct"]));
    // Highest grant wins: Lena's direct viewer role does not lower the default editor.
    const lena = members.find((m) => m.email === "lena@example.com");
    expect(lena).toMatchObject({ effective_role: "editor", direct_role: "viewer" });
  });

  it("filters and pages", async () => {
    const me = await signIn();
    expect((await client.projectAccess("shop", { source: "direct" }, me)).members).toHaveLength(3);
    expect((await client.projectAccess("shop", { role: "admin" }, me)).members?.map((m) => m.email)).toEqual([
      "ada@example.com",
      "olive@example.com",
      "priya@example.com",
      "you@example.com",
    ]);
    const first = await client.projectAccess("shop", { limit: 5 }, me);
    const second = await client.projectAccess("shop", { limit: 5, cursor: first.next_cursor }, me);
    expect(first.members).toHaveLength(5);
    expect(second.members).toHaveLength(4);
    expect(second.next_cursor).toBe("");
  });

  it("grants, changes and removes a direct role", async () => {
    const me = await signIn();
    const sam = (await client.projectAccess("shop", { q: "sam" }, me)).members?.[0];
    expect(sam).toMatchObject({ effective_role: "viewer", direct_role: null });
    const granted = await client.setProjectMember("shop", sam!.user_id, "editor", me);
    expect(granted).toMatchObject({ effective_role: "editor", direct_role: "editor", added_by: { id: me.userId } });
    await client.removeProjectMember("shop", sam!.user_id, me);
    expect((await client.projectAccess("shop", { q: "sam" }, me)).members?.[0]).toMatchObject({ direct_role: null, effective_role: "viewer" });
    await expect(client.setProjectMember("shop", "00000000-0000-4000-8000-000000000000", "viewer", me)).rejects.toMatchObject({ status: 409, code: "not_org_member" });
  });

  it("dry-runs and changes the default access", async () => {
    const me = await signIn();
    const dry = await client.setDefaultAccess("shop", "none", { dryRun: true }, me);
    expect(dry).toEqual({ default_access: "org_role", previous_default_access: "org_role", lose_access: 3, dry_run: true });
    const done = await client.setDefaultAccess("shop", "none", {}, me);
    expect(done).toMatchObject({ default_access: "none", lose_access: 3, dry_run: false });
    expect((await client.projectAccess("shop", {}, me)).members).toHaveLength(6);
  });

  it("refuses writes and the invitations without access.manage, and reads the project's invitations with it", async () => {
    const viewer = await signIn({ capabilities: ["project.read"] });
    await expect(client.setDefaultAccess("shop", "viewer", {}, viewer)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    // The API's rule (#779): the project's pending invitations need manage_access.
    await expect(client.projectInvitations("shop", viewer)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const admin = await signIn({ capabilities: ["project.read", "access.manage"] });
    const invitations = (await client.projectInvitations("shop", admin)) ?? [];
    expect(invitations.map((i) => [i.email, i.project_grants?.[0]?.role])).toEqual([
      ["new.dev@example.com", "editor"],
      ["contractor@example.com", "viewer"],
    ]);
  });
});

describe("audit log", () => {
  it("lists forty events over three weeks, newest first, on the org and fewer on the project", async () => {
    const me = await signIn();
    const org = await client.listAuditEvents({ org: "acme" }, { limit: 200 }, me);
    const events = org.events ?? [];
    expect(events).toHaveLength(40);
    expect(org.retention_days).toBe(400);
    const times = events.map((e) => Date.parse(e.time));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(times[0] - times[times.length - 1]).toBeGreaterThan(20 * 24 * 3600_000);
    const project = await client.listAuditEvents({ project: "shop" }, { limit: 200 }, me);
    expect(project.events?.length).toBeLessThan(40);
    expect(project.events?.every((e) => e.project === undefined)).toBe(true);
  });

  it("filters by action prefix and pages with the cursor", async () => {
    const me = await signIn();
    const keys = await client.listAuditEvents({ project: "shop" }, { action: "api_key." }, me);
    expect(keys.events?.every((e) => e.action.startsWith("api_key."))).toBe(true);
    const first = await client.listAuditEvents({ project: "shop" }, { limit: 10 }, me);
    const second = await client.listAuditEvents({ project: "shop" }, { limit: 10, cursor: first.next_cursor }, me);
    expect(second.events?.[0]?.id).not.toBe(first.events?.[0]?.id);
  });

  it("lists the actions and exports CSV", async () => {
    const me = await signIn();
    const { actions } = await client.auditActions({ project: "shop" }, me);
    expect(actions).toContainEqual({ action: "api_key.created", label: "API key created" });
    const res = await fetch(client.auditExportUrl({ project: "shop" }, { action: "project_member." }), {
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe("timestamp,action,actor_id,actor_name,actor_email,ip,user_agent,request_id,target_type,target_id,target_label,project,previous,next");
    expect(lines.slice(1).every((l) => l.split(",")[1].startsWith("project_member."))).toBe(true);
  });

  it("needs audit.read", async () => {
    const viewer = await signIn({ capabilities: ["project.read"] });
    await expect(client.listAuditEvents({ project: "shop" }, {}, viewer)).rejects.toMatchObject({ status: 403 });
  });
});

describe("API keys", () => {
  it("seeds four keys in different states with the new fields", async () => {
    const me = await signIn({ api_keys: "measured" });
    const keys = await client.listApiKeys("shop", me);
    expect(keys).toHaveLength(4);
    const [current, rotated, staging, revoked] = keys;
    expect(current.rotated_from).toBe(rotated.id);
    expect(rotated.rotated_to).toBe(current.id);
    expect(current).toMatchObject({ environments: ["production"], last_used_sdk: "apilenss/0.5.0", created_by: { name: "Ada Admin" } });
    expect(staging).toMatchObject({ rate_limit_per_minute: 6000, environments: ["staging"] });
    expect(revoked.revoked_at).not.toBeNull();
  });

  it("rotates a key with an overlap window, once", async () => {
    const me = await signIn({ api_keys: "measured" });
    const staging = (await client.listApiKeys("shop", me))[2];
    const rotated = await client.rotateApiKey("shop", staging.id, "24h", me);
    expect(rotated.key).toMatch(/^apl_live_/);
    expect(rotated).toMatchObject({ name: "Staging worker", rotated_from: staging.id, environments: ["staging"], rate_limit_per_minute: 6000 });
    expect(rotated.previous.rotated_to).toBe(rotated.id);
    const overlapEnd = Date.parse(rotated.previous.expires_at ?? "");
    expect(overlapEnd - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(overlapEnd - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    await expect(client.rotateApiKey("shop", staging.id, "none", me)).rejects.toMatchObject({ status: 409, code: "key_not_active" });
  });

  it("creates a key pinned to environments with a rate limit", async () => {
    const me = await signIn();
    const created = await client.createApiKey("shop", { name: "Edge", scopes: ["ingest"], environments: ["production"], rate_limit_per_minute: 1200 }, me);
    expect(created).toMatchObject({ environments: ["production"], rate_limit_per_minute: 1200, rotated_from: null, rotated_to: null, created_by: { id: me.userId } });
    // The app-access route still answers next to the new rotate route.
    const updated = await client.updateApiKeyAccess("shop", created.id, { can_create_apps: false, app_ids: null }, me);
    expect(updated).toMatchObject({ id: created.id, can_create_apps: false });
  });
});
