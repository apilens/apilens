// Account settings → Preferences → Home screen (#994) against the fake identity
// (e2e-fake/fake-identity.ts): the pick persists, and `/` opens shop on the view it maps to, or on
// Settings > SDK setup while shop has no ingested data. `/__fake/apps` seeds whether shop's app was seen.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const PAGE = "/settings/preferences";

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, next: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

/** shop's one app, seen by an SDK (`first_seen_at` set) or never. */
async function seedShop(seen: boolean) {
  const managed = seen ? { first_seen_at: "2026-11-10T09:00:00Z", last_seen_at: "2026-11-16T09:00:00Z" } : {};
  const apps = [{ id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d", slug: "shop", name: "Shop", managed }];
  const res = await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps }) });
  expect(res.status).toBe(204);
}

test.afterAll(async () => {
  await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps: [] }) });
});

test("the home screen persists and decides where / opens", async ({ page }) => {
  await seedShop(true);
  await signIn(page, PAGE);
  await expect(page.getByRole("heading", { level: 2, name: "Preferences" })).toBeVisible();
  const card = page.getByRole("form", { name: "Home screen" });
  const save = card.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();

  await card.getByRole("radio", { name: /^Requests across services/ }).check();
  await save.click();
  await expect(card.getByRole("status")).toHaveText("Home screen saved.");
  await expect(save).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("form", { name: "Home screen" }).getByRole("radio", { name: /^Requests across services/ })).toBeChecked();

  await page.goto("/");
  await page.waitForURL((url) => url.pathname === "/project/shop/explore");

  await page.goto(PAGE);
  await page.getByRole("radio", { name: /^Slow or failing endpoints/ }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Home screen saved." })).toBeVisible();
  await page.goto("/");
  await page.waitForURL((url) => url.pathname === "/project/shop/traffic");
});

test("a project with no ingested data opens SDK setup", async ({ page }) => {
  await seedShop(false);
  await signIn(page, PAGE);
  await page.goto("/");
  await page.waitForURL((url) => url.pathname === "/project/shop/settings/sdk");
  // One PageHeader (#992, D7): the page title is the nav label, the section its subheading.
  const header = page.locator("header.ph");
  await expect(header.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
  await expect(header.getByRole("heading", { level: 2, name: "SDK setup" })).toBeVisible();
});
