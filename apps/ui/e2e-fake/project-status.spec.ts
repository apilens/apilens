// Renamed slugs and the paused banner on every project page (#823) against the fake identity
// (e2e-fake/fake-identity.ts), which keeps resolving shop's old slug after a rename, lists shop in
// the context under its current slug and serves pause/resume (`/__fake/project` seeds and resets
// it). No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "project.delete"];
const EDITOR = ["project.read", "project.update"];

async function seedProject(body: Record<string, unknown> = {}) {
  await fetch(`${IDENTITY}/__fake/project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page, next: string, capabilities: string[] = ADMIN) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

const banner = (page: Page) => page.getByRole("region", { name: "Data collection paused" });

test.beforeEach(async () => {
  await seedProject();
});

test.afterAll(async () => {
  await seedProject();
});

test("an old slug deep link lands on the same view under the new slug, query kept", async ({ page }) => {
  await seedProject({ project: { slug: "shop-api" } });
  await signIn(page, "/shop-api/traffic");

  const res = await page.goto("/shop/traffic?range=7d&env=production");
  await page.waitForURL((url) => url.pathname === "/shop-api/traffic");
  expect(new URL(page.url()).search).toBe("?range=7d&env=production");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Traffic" })).toBeVisible();
  // The switcher and sidebar name the project by its current slug.
  await expect(page.getByRole("link", { name: "Explore" })).toHaveAttribute("href", /^\/shop-api\/explore/);
});

test("a paused project shows the banner on every page and Resume clears it", async ({ page }) => {
  await seedProject({ project: { paused_at: new Date().toISOString(), paused_by: null } });
  await signIn(page, "/shop/traffic");
  const b = banner(page);
  await expect(b).toContainText("Data collection is paused.");
  await expect(b).not.toContainText("A project admin can resume it.");

  await page.goto("/shop/settings/danger");
  await expect(banner(page)).toBeVisible();
  // General has its own fuller notice, so the banner stays off that page.
  await page.goto("/shop/settings");
  await expect(page.getByRole("region", { name: "Ingest is paused" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  await page.goto("/shop/traffic");
  await banner(page).getByRole("button", { name: "Resume" }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Data collection resumed." })).toBeAttached();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Traffic" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test("pausing from the Danger zone shows the banner without a reload", async ({ page }) => {
  await signIn(page, "/shop/settings/danger");
  await expect(banner(page)).toHaveCount(0);
  const card = page.getByRole("region", { name: "Danger zone actions" });
  await card.getByRole("button", { name: "Pause data collection" }).click();
  const d = page.getByRole("dialog", { name: "Pause data collection for Shop?" });
  await d.getByRole("textbox").fill("Shop");
  await d.getByRole("button", { name: "Pause data collection" }).click();
  await expect(banner(page)).toBeVisible();
});

test("an editor sees the banner without Resume", async ({ page }) => {
  await seedProject({ project: { paused_at: new Date().toISOString(), paused_by: null } });
  await signIn(page, "/shop/traffic", EDITOR);
  const b = banner(page);
  await expect(b).toContainText("A project admin can resume it.");
  await expect(b.getByRole("button")).toHaveCount(0);
});

test("an active project shows no banner", async ({ page }) => {
  await signIn(page, "/shop/traffic");
  await expect(page.getByRole("heading", { level: 1, name: "Traffic" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});
