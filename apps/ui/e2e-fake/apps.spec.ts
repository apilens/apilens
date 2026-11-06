// Apps overview (#591) against the fake identity (e2e-fake/fake-identity.ts), which serves shop's
// apps (`GET /project`), each app's SDK status and counters (`GET /apps/{id}/status`) and its traffic
// (`GET /traffic/summary|timeseries?app=`) as `/__fake/apps` seeded them; `/__fake/query-down`
// makes those reads answer 503. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/apps";
const CHECKOUT = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const WORKER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const LEGACY = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const bucket = (i: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 30 * 60_000).toISOString();
const points = (...requests: number[]) => requests.map((r, i) => ({ ts: bucket(i), requests: r, client_errors: 0, server_errors: 0, p95_ms: 100 }));

const APPS = [
  {
    id: CHECKOUT,
    slug: "checkout-api",
    name: "Checkout API",
    status: {
      status: "reporting",
      last_seen_at: ago(20),
      sdks: [{ name: "apilens-python", versions: ["0.4.0"], latest_version: "0.4.0", outdated_instances: 0 }],
    },
    traffic: {
      summary: { requests: 172_800, client_errors: 2_592, server_errors: 864, error_rate: 0.02, p50_ms: 38, p95_ms: 412.6, p99_ms: 980, requests_per_minute: 120 },
      points: points(100, 140, 90, 160),
    },
  },
  {
    id: WORKER,
    slug: "refunds-worker",
    name: "refunds-worker",
    sdk_stats: { instances: 3, failed_batches: 2, dropped_records: 140, drop_counts: { queue_full: 140 } },
    status: {
      status: "stale",
      last_seen_at: ago(18 * 60),
      sdks: [{ name: "apilens-java", versions: ["1.2.1", "1.3.0"], latest_version: "1.3.0", outdated_instances: 2 }],
    },
    traffic: {
      summary: { requests: 10_000, client_errors: 100, server_errors: 610, error_rate: 0.071, p50_ms: 210, p95_ms: 1820, p99_ms: 4000, requests_per_minute: 6.94 },
      points: points(5, 9, 2, 7),
    },
  },
  { id: LEGACY, slug: "legacy", name: "legacy", status: { status: "silent", last_seen_at: ago(9 * 86_400), sdks: [{ name: "apilens-go", versions: ["0.8.0"], latest_version: "0.9.2", outdated_instances: 1 }] } },
];

async function seedApps(apps: Record<string, unknown>[] = APPS) {
  const res = await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps }) });
  expect(res.status).toBe(204);
}

async function queryDown(down: boolean) {
  await fetch(`${IDENTITY}/__fake/query-down`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "shop", down }) });
}

async function signIn(page: Page, next = PAGE) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next }) });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

const card = (page: Page, name: string) => page.getByRole("list", { name: "Apps" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });

test.afterEach(async () => {
  await queryDown(false);
  // Other specs expect shop's single default app.
  await seedApps([]);
});

test("shows a card per app with its traffic, health, SDK status and version against the latest", async ({ page }) => {
  await seedApps();
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Apps" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".ap-lead")).toContainText("2 apps need attention.");
  await expect(page.getByRole("list", { name: "Apps" }).getByRole("listitem")).toHaveCount(3);
  // The project switcher counts the project's apps from the context (app_count).
  await expect(page.locator(".oh--project small")).toHaveText("Project · 3 apps");

  const checkout = card(page, "Checkout API");
  await expect(checkout.locator(".ap-slug")).toHaveText("checkout-api");
  await expect(checkout.locator(".ap-pill")).toHaveText("Reporting");
  await expect(checkout.locator(".ap-metrics dt")).toHaveText(["Requests/min", "Error rate", "p95"]);
  await expect(checkout.locator(".ap-metrics dd")).toHaveText(["120", "2.0%", "413 ms"]);
  await expect(checkout.locator("svg.tr-spark polyline")).toHaveCount(1);
  await expect(checkout.locator(".ap-health")).toHaveText("Healthy");
  await expect(checkout.locator(".ap-sdk")).toHaveText("apilens-python 0.4.0");
  await expect(checkout.locator(".ap-update")).toHaveCount(0);
  await expect(checkout.locator(".ap-drops")).toHaveCount(0);
  await expect(checkout).toContainText("Last seen just now");

  const worker = card(page, "refunds-worker");
  await expect(worker.locator(".ap-slug")).toHaveCount(0);
  await expect(worker.locator(".ap-pill")).toHaveText("Stale");
  await expect(worker.locator(".ap-pill")).toHaveAttribute("title", "No heartbeat in the last 2 minutes.");
  await expect(worker.locator(".ap-metrics dd")).toHaveText(["6.9", "7.1%", "1.82 s"]);
  await expect(worker.locator(".ap-health")).toHaveText("Failing");
  await expect(worker.locator(".ap-sdk code")).toHaveText("apilens-java 1.2.1 to 1.3.0");
  await expect(worker.locator(".ap-update")).toHaveText("Update available: 1.3.0 (2 instances behind)");
  await expect(worker.locator(".ap-drops")).toHaveText("2 batches failed · 140 records dropped");
  await expect(worker).toContainText("Last seen 18 min ago");

  // No traffic in the range: no p95, no health beyond saying so.
  const legacy = card(page, "legacy");
  await expect(legacy.locator(".ap-pill")).toHaveText("Silent");
  await expect(legacy.locator(".ap-metrics dd")).toHaveText(["0", "0%", "n/a"]);
  await expect(legacy.locator(".ap-health")).toHaveText("No traffic");
  await expect(legacy.locator(".ap-update")).toHaveText("Update available: 0.9.2 (1 instance behind)");
  await expect(legacy).toContainText("Last seen 9 days ago");

  const a11y = await new AxeBuilder({ page }).include(".ap").analyze();
  expect(a11y.violations).toEqual([]);

  // The whole card opens the app: its link covers the card, so a click on the numbers lands on it.
  await worker.locator(".ap-metrics").click({ force: true });
  await page.waitForURL("**/shop/apps/refunds-worker");
  await expect(page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Apps" })).toHaveAttribute("aria-current", "page");
});

test("an app that never sent a heartbeat says so", async ({ page }) => {
  await seedApps([{ id: CHECKOUT, slug: "shop", name: "Shop" }]);
  await signIn(page);
  const shop = card(page, "Shop");
  await expect(shop.locator(".ap-pill")).toHaveText("Never reported");
  await expect(shop).toContainText("No SDK reported yet");
  await expect(shop).toContainText("No heartbeat yet");
  await expect(page.locator(".ap-lead")).not.toContainText("attention");
});

test("says when an app’s status or traffic cannot be read", async ({ page }) => {
  await seedApps();
  await signIn(page);
  await queryDown(true);
  await page.reload();
  await expect(page.getByRole("list", { name: "Apps" }).getByRole("listitem")).toHaveCount(3);
  await expect(card(page, "Checkout API")).toContainText("Traffic unavailable.");
  await expect(card(page, "Checkout API")).toContainText("SDK status unavailable.");
  await queryDown(false);
  await page.reload();
  await expect(card(page, "Checkout API").locator(".ap-pill")).toHaveText("Reporting");
});

test("an unknown app is not found", async ({ page }) => {
  await seedApps();
  await signIn(page);
  const res = await page.goto("/shop/apps/nope");
  expect(res?.status()).toBe(404);
});

test("lays out at phone width without scrolling sideways", async ({ page }) => {
  await seedApps();
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(card(page, "Checkout API")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("screenshots", async ({ page }) => {
  const dir = process.env.APPS_SHOTS;
  test.skip(!dir, "set APPS_SHOTS to a directory to capture screenshots");
  await seedApps();
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(card(page, "Checkout API")).toBeVisible();
      await page.screenshot({ path: `${dir}/apps-${theme}-${width}.png`, fullPage: true });
    }
  }
});
