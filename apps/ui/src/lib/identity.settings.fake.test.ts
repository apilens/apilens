// The project settings client methods (#805) against the fake identity (e2e-fake/fake-identity.ts),
// started here on its own port: each method hits its fake route and the measured seed answers.
// No email is sent, no real backend is involved.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type IdentityClient, createClient } from "./identity";

const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP_ID = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";

let server: ChildProcess;
let client: IdentityClient;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Signs in a fresh fake user (owner of acme unless seeded otherwise) and answers their access token. */
async function signIn(seed: Record<string, unknown> = {}): Promise<{ accessToken: string; userId: string }> {
  const { code } = (await (await post("/__fake/handoff", { next: "/", ...seed })).json()) as { code: string };
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
  await post("/__fake/project", {});
  await post("/__fake/environments", {});
  await post("/__fake/retention", {});
});

const EDITOR = ["project.read", "project.update", "api_keys.create", "api_keys.revoke"];

describe("general", () => {
  it("updates the name, description and repository link, normalising the link", async () => {
    const me = await signIn();
    const updated = await client.updateProject("shop", { name: "  Shop API ", repository_url: "https://github.com/acme/shop.git/" }, me);
    expect(updated).toMatchObject({
      id: SHOP_ID,
      slug: "shop",
      name: "Shop API",
      description: "Storefront API: catalogue, cart and checkout.",
      role: "admin",
      repository_url: "https://github.com/acme/shop",
      commit_url_template: "https://github.com/acme/shop/commit/{commit}",
      paused_at: null,
      canonical_slug: "shop",
    });
    expect((await client.getProject("shop", me)).repository_url).toBe("https://github.com/acme/shop");
    expect(Date.parse(updated.updated_at)).toBeGreaterThan(Date.now() - 60_000);
    const cleared = await client.updateProject("shop", { description: "", repository_url: "" }, me);
    expect(cleared).toMatchObject({ description: "", repository_url: null, commit_url_template: null });
  });

  it("refuses an invalid change and a viewer", async () => {
    const me = await signIn();
    await expect(client.updateProject("shop", { name: " " }, me)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(client.updateProject("shop", { repository_url: "http://github.com/acme/shop" }, me)).rejects.toMatchObject({
      code: "invalid_request",
      problem: { detail: "The repository link must start with https://." },
    });
    await expect(client.updateProject("shop", { description: "x".repeat(281) }, me)).rejects.toMatchObject({ code: "invalid_request" });
    const viewer = await signIn({ capabilities: ["project.read"] });
    await expect(client.updateProject("shop", { name: "Nope" }, viewer)).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("danger zone", () => {
  it("pauses and resumes ingest", async () => {
    const me = await signIn();
    const paused = await client.pauseProject("shop", me);
    expect(paused.paused_at).not.toBeNull();
    expect(paused.paused_by).toBe(me.userId);
    const again = await client.pauseProject("shop", me);
    expect(again.paused_at).toBe(paused.paused_at);
    expect(await client.resumeProject("shop", me)).toMatchObject({ paused_at: null, paused_by: null });
    const editor = await signIn({ capabilities: EDITOR });
    await expect(client.pauseProject("shop", editor)).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("renames the slug; the old one keeps resolving and a taken one is refused", async () => {
    const me = await signIn();
    await expect(client.renameProject("shop", "storefront", me)).rejects.toMatchObject({ status: 409, code: "slug_taken" });
    await expect(client.renameProject("shop", "Shop API", me)).rejects.toMatchObject({ status: 422, code: "invalid_request" });
    const renamed = await client.renameProject("shop", "shop-api", me);
    expect(renamed).toMatchObject({ slug: "shop-api", canonical_slug: "shop-api" });
    expect((await client.listEnvironments("shop", me)).environments).toHaveLength(5);
    expect((await client.renameProject("shop-api", "shop", me)).slug).toBe("shop");
  });

  it("deletes with the typed slug, lists the deleted project and restores it", async () => {
    const me = await signIn();
    await expect(client.deleteProject("shop", "Shop", me)).rejects.toMatchObject({ status: 422, code: "confirmation_mismatch" });
    const deleted = await client.deleteProject("shop", "shop", me);
    expect(deleted).toMatchObject({ id: SHOP_ID, slug: "shop", name: "Shop" });
    const grace = Date.parse(deleted.purge_after) - Date.parse(deleted.deleted_at);
    expect(grace).toBe(7 * 24 * 3600_000);
    await expect(client.listEnvironments("shop", me)).rejects.toMatchObject({ status: 404 });
    const list = (await client.listDeletedProjects("acme", me)) ?? [];
    expect(list.map((p) => p.slug)).toEqual(["shop", "legacy-checkout"]);
    const restored = await client.restoreProject("acme", SHOP_ID, me);
    expect(restored).toMatchObject({ id: SHOP_ID, slug: "shop" });
    expect((await client.listDeletedProjects("acme", me))?.map((p) => p.slug)).toEqual(["legacy-checkout"]);
    await expect(client.restoreProject("acme", SHOP_ID, me)).rejects.toMatchObject({ status: 404 });
  });

  it("needs a recent sign-in to delete, and an org owner or admin to list and restore", async () => {
    const stale = await signIn({ stale: true });
    await expect(client.deleteProject("shop", "shop", stale)).rejects.toMatchObject({ status: 403, code: "reauth_required" });
    const member = await signIn({ role: "member" });
    await expect(client.listDeletedProjects("acme", member)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(client.restoreProject("acme", "f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b9c", member)).rejects.toMatchObject({ status: 403 });
  });
});

describe("environments", () => {
  it("lists five measured environments in order, hidden ones included", async () => {
    const me = await signIn();
    const { environments, max_environments } = await client.listEnvironments("shop", me);
    expect(max_environments).toBe(20);
    expect(environments?.map((e) => [e.name, e.position, e.hidden, e.deletable])).toEqual([
      ["production", 0, false, false],
      ["staging", 1, false, false],
      ["canary", 2, false, false],
      ["preview", 3, false, true],
      ["qa-legacy", 4, true, false],
    ]);
    expect(environments?.[0]).toMatchObject({ is_production: true, color: "green", source: "sdk", api_keys: 2, health_checks: 1, has_data: true });
    expect(environments?.[3]).toMatchObject({ source: "dashboard", first_seen_at: null, color: null });
  });

  it("adds one (once), refuses a bad name, and a viewer", async () => {
    const me = await signIn();
    expect((await client.addEnvironment("shop", "load-test", me)).environments).toContain("load-test");
    expect((await client.addEnvironment("shop", "load-test", me)).environments?.filter((e) => e === "load-test")).toHaveLength(1);
    await expect(client.addEnvironment("shop", "-bad", me)).rejects.toMatchObject({ status: 422, code: "invalid_request" });
    const viewer = await signIn({ capabilities: ["project.read"] });
    await expect(client.addEnvironment("shop", "qa", viewer)).rejects.toMatchObject({ status: 403 });
  });

  it("updates the flag, colour, hidden state and position", async () => {
    const me = await signIn();
    const canary = await client.updateEnvironment("shop", "canary", { is_production: true, color: "none", hidden: true, position: 0 }, me);
    expect(canary).toMatchObject({ name: "canary", is_production: true, color: null, hidden: true, position: 0 });
    expect(canary.hidden_at).not.toBeNull();
    await expect(client.updateEnvironment("shop", "nope", { hidden: true }, me)).rejects.toMatchObject({ status: 404 });
  });

  it("reorders, the others following in their order", async () => {
    const me = await signIn();
    const { environments } = await client.reorderEnvironments("shop", ["preview", "staging"], me);
    expect(environments?.map((e) => e.name)).toEqual(["preview", "staging", "production", "canary", "qa-legacy"]);
    await expect(client.reorderEnvironments("shop", ["preview", "preview"], me)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("removes an empty environment and refuses one in use", async () => {
    const me = await signIn();
    expect((await client.removeEnvironment("shop", "preview", me)).environments).not.toContain("preview");
    await expect(client.removeEnvironment("shop", "qa-legacy", me)).rejects.toMatchObject({ status: 409, code: "environment_in_use" });
  });
});

describe("retention and usage", () => {
  it("reads the retention per signal", async () => {
    const me = await signIn();
    const { signals } = await client.projectRetention("shop", me);
    expect(signals?.map((s) => [s.key, s.period_days, s.configurable])).toEqual([
      ["requests", 90, true],
      ["logs", 30, true],
      ["spans", 30, true],
      ["rollups_1m", 30, true],
      ["rollups_1h", 400, true],
      ["deploys", 400, false],
    ]);
    await post("/__fake/retention", { signals: [{ key: "requests", label: "Requests", period_days: 30, covers: "", configurable: true }] });
    expect((await client.projectRetention("shop", me)).signals).toHaveLength(1);
  });

  it("reads the project usage", async () => {
    const me = await signIn();
    const usage = await client.projectUsage("shop", 7, me);
    expect(usage.project).toBe("shop");
    expect(usage.daily).toHaveLength(7);
  });

  it("answers 503 for the settings reads while down", async () => {
    const me = await signIn();
    await post("/__fake/project", { down: true });
    await expect(client.listEnvironments("shop", me)).rejects.toMatchObject({ status: 503 });
  });
});
